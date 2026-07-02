import { unlink } from "node:fs/promises";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { InlineKeyboardMarkup, Message } from "grammy/types";
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

// Лимит Bot API на подпись к медиа
const CAPTION_LIMIT = 1024;

/** Пост с медиа (фото/видео из источника) или текстом, если медиа нет/не влезает подпись. */
async function sendPost(
  chatId: number | string,
  draft: Draft,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<Message> {
  const opts = { parse_mode: "HTML" as const, reply_markup: replyMarkup };
  if (draft.media_path && text.length <= CAPTION_LIMIT) {
    const input = draft.media_path.startsWith("http")
      ? draft.media_path
      : new InputFile(draft.media_path);
    try {
      if (draft.media_type === "video") {
        return await bot.api.sendVideo(chatId, input, { ...opts, caption: text });
      }
      return await bot.api.sendPhoto(chatId, input, { ...opts, caption: text });
    } catch (err) {
      // битый URL из RSS или проблемный файл — не теряем пост, шлём текстом
      console.error(`Черновик #${draft.id}: медиа не отправилось, шлю текстом:`, err);
    }
  }
  return await bot.api.sendMessage(chatId, text, {
    ...opts,
    link_preview_options: { is_disabled: true },
  });
}

/** Удаляет локальный медиа-файл черновика (скачанный из Telegram). */
async function cleanupMedia(draft: Draft): Promise<void> {
  if (draft.media_path && !draft.media_path.startsWith("http")) {
    await unlink(draft.media_path).catch(() => {});
  }
}

export async function sendDraftToAdmin(draft: Draft): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("✅ Опубликовать", `pub:${draft.id}`)
    .text("❌ Пропустить", `skip:${draft.id}`);

  const msg = await sendPost(adminChatId(), draft, renderDraftPreview(draft), keyboard);
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
    try {
      await sendPost(config.channelId, draft, renderPost(draft));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.answerCallbackQuery({ text: "Не смог опубликовать", show_alert: true });
      await ctx.reply(
        `Публикация не удалась: ${reason}\n\nПроверь CHANNEL_ID в .env — там должен быть юзернейм канала (не бота), а бот — админом канала с правом публикации. После правки перезапусти bun start и нажми кнопку ещё раз.`,
      );
      return;
    }
    setDraftStatus(draft.id, "published");
    await cleanupMedia(draft);
    // editMessageText не работает для медиа-сообщений — просто снимаем кнопки
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.answerCallbackQuery({ text: "Опубликовано ✅" });
    await ctx.reply(`✅ Черновик #${draft.id} опубликован`);
  } else {
    setDraftStatus(draft.id, "skipped");
    await cleanupMedia(draft);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.answerCallbackQuery({ text: "Пропущено" });
    await ctx.reply(`❌ Черновик #${draft.id} пропущен`);
  }
});

// Любая необработанная ошибка в хендлерах логируется, но не роняет бота
bot.catch((err) => {
  const reason = err.error instanceof Error ? err.error.message : String(err.error);
  console.error(`Ошибка бота (update ${err.ctx.update.update_id}): ${reason}`);
});

/** Проверка канала публикации при старте — понятное предупреждение вместо падения на первой кнопке. */
export async function validateChannel(): Promise<void> {
  const me = await bot.api.getMe();
  const target = typeof config.channelId === "string" ? config.channelId.replace("@", "") : "";
  if (target && me.username && target.toLowerCase() === me.username.toLowerCase()) {
    console.warn(
      "ВНИМАНИЕ: CHANNEL_ID указывает на самого бота — публикация не сработает. Впиши в .env юзернейм КАНАЛА и перезапусти.",
    );
    return;
  }
  try {
    await bot.api.getChat(config.channelId);
    console.log(`Канал публикации: ${config.channelId}`);
  } catch {
    console.warn(
      `ВНИМАНИЕ: канал ${config.channelId} недоступен боту — проверь CHANNEL_ID в .env и что бот добавлен админом с правом публикации.`,
    );
  }
}

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
