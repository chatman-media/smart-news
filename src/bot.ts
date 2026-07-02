import { Bot, InlineKeyboard } from "grammy";
import { adminChatId, config } from "./config";
import { type Draft, getDraft, setAdminMsgId, setDraftStatus } from "./db";

export const bot = new Bot(config.botToken);

const CATEGORY_EMOJI: Record<string, string> = {
  safety: "⚠️",
  visa_docs: "🛂",
  transport: "✈️",
  events: "🎉",
  money: "💱",
  weather: "🌧",
  infrastructure: "🔧",
  other: "📌",
  place: "🌴",
  activity: "🤿",
};

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderPost(d: Draft): string {
  const emoji = CATEGORY_EMOJI[d.category] ?? "📌";
  const lines = [`${emoji} <b>${escapeHtml(d.title)}</b>`, "", escapeHtml(d.summary)];
  if (d.link) {
    lines.push("", `<a href="${d.link}">Источник</a>`);
  }
  return lines.join("\n");
}

function renderDraftPreview(d: Draft): string {
  const origin =
    d.source === "rubric"
      ? "рубрика"
      : d.source.startsWith("rss:")
        ? d.source.slice(4)
        : `@${d.source}`;
  return [
    `<b>Черновик #${d.id}</b> · ${d.category} · ${d.tone} · важность ${d.importance}/5 · ${origin}`,
    "",
    renderPost(d),
  ].join("\n");
}

export async function sendDraftToAdmin(draft: Draft): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("✅ Опубликовать", `pub:${draft.id}`)
    .text("❌ Пропустить", `skip:${draft.id}`);

  const msg = await bot.api.sendMessage(adminChatId(), renderDraftPreview(draft), {
    parse_mode: "HTML",
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
  setAdminMsgId(draft.id, msg.message_id);
}

function isAdmin(userId: number | undefined): boolean {
  return userId != null && userId === config.adminChatId;
}

bot.callbackQuery(/^(pub|skip):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Не твоя кнопка" });
    return;
  }
  const action = ctx.match[1];
  const draft = getDraft(Number(ctx.match[2]));
  if (!draft) {
    await ctx.answerCallbackQuery({ text: "Черновик не найден" });
    return;
  }
  if (draft.status !== "pending") {
    await ctx.answerCallbackQuery({ text: `Уже обработан: ${draft.status}` });
    return;
  }

  if (action === "pub") {
    await bot.api.sendMessage(config.channelId, renderPost(draft), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    setDraftStatus(draft.id, "published");
    await ctx.editMessageText(`${renderDraftPreview(draft)}\n\n✅ <b>Опубликовано</b>`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    await ctx.answerCallbackQuery({ text: "Опубликовано ✅" });
  } else {
    setDraftStatus(draft.id, "skipped");
    await ctx.editMessageText(`${renderDraftPreview(draft)}\n\n❌ <b>Пропущено</b>`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    await ctx.answerCallbackQuery({ text: "Пропущено" });
  }
});

/** Регистрирует админ-команды. */
export function registerAdminCommands(
  runNow: () => Promise<number>,
  makeRubric: (kind: "place" | "activity") => Promise<Draft | null>,
): void {
  bot.command("rubric", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const kind = ctx.match?.trim() === "activity" ? "activity" : "place";
    await ctx.reply(`Генерирую рубрику (${kind})…`);
    try {
      const draft = await makeRubric(kind);
      if (draft) {
        await sendDraftToAdmin(draft);
      } else {
        await ctx.reply("Не получилось: нет свободной темы");
      }
    } catch (err) {
      await ctx.reply(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("check", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    await ctx.reply("Проверяю источники…");
    try {
      const drafts = await runNow();
      await ctx.reply(drafts > 0 ? `Готово: ${drafts} новых черновиков` : "Нового ничего нет");
    } catch (err) {
      await ctx.reply(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("start", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    await ctx.reply(
      "Я собираю новости из каналов-источников, фильтрую через Claude и присылаю сюда черновики с кнопками. /check — проверить источники сейчас, /rubric [place|activity] — сгенерировать рубрику.",
    );
  });
}
