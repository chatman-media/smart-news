import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config";
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
};

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderPost(d: Draft): string {
  const emoji = CATEGORY_EMOJI[d.category] ?? "📌";
  return [
    `${emoji} <b>${escapeHtml(d.title)}</b>`,
    "",
    escapeHtml(d.summary),
    "",
    `<a href="${d.link}">Источник</a>`,
  ].join("\n");
}

function renderDraftPreview(d: Draft): string {
  return [
    `<b>Черновик #${d.id}</b> · ${d.category} · важность ${d.importance}/5 · @${d.source}`,
    "",
    renderPost(d),
  ].join("\n");
}

export async function sendDraftToAdmin(draft: Draft): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("✅ Опубликовать", `pub:${draft.id}`)
    .text("❌ Пропустить", `skip:${draft.id}`);

  const msg = await bot.api.sendMessage(config.adminChatId, renderDraftPreview(draft), {
    parse_mode: "HTML",
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
  setAdminMsgId(draft.id, msg.message_id);
}

function isAdmin(userId: number | undefined): boolean {
  return userId === config.adminChatId;
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

/** Регистрирует админ-команды; runNow — ручной прогон пайплайна. */
export function registerAdminCommands(runNow: () => Promise<number>): void {
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
      "Я собираю новости из каналов-источников, фильтрую через Claude и присылаю сюда черновики с кнопками. /check — проверить источники сейчас.",
    );
  });
}
