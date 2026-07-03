import { unlink } from "node:fs/promises";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { InlineKeyboardMarkup, Message } from "grammy/types";
import { adminChatId, config } from "./config";
import {
  bumpStat,
  type Draft,
  engagementByCategory,
  getDraft,
  getScoutCandidate,
  listDraftSources,
  publishedByCategory,
  type ScoutCandidate,
  setAdminMsgId,
  setChannelMsgId,
  setDraftStatus,
  setScoutStatus,
  statsRange,
} from "./db";
import { addSource } from "./sources";

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

function sourceLabel(source: string): string {
  return source.startsWith("rss:") ? source.slice(4) : `@${source}`;
}

function renderPost(d: Draft): string {
  const emoji = CATEGORY_EMOJI[d.category] ?? "📌";
  const lines = [`${emoji} <b>${escapeHtml(d.title)}</b>`, "", escapeHtml(d.summary)];
  const extras = listDraftSources(d.id);
  if (d.link && extras.length > 0) {
    const all = [
      `<a href="${d.link}">${escapeHtml(sourceLabel(d.source))}</a>`,
      ...extras.map((s) => `<a href="${s.link}">${escapeHtml(sourceLabel(s.source))}</a>`),
    ];
    lines.push("", `Источники: ${all.join(" · ")}`);
  } else if (d.link) {
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
  // Ссылка на видео (YouTube/FB/TikTok): текст + большое playable-превью над ним
  if (draft.media_type === "video_link" && draft.media_path) {
    return await bot.api.sendMessage(chatId, text, {
      ...opts,
      link_preview_options: {
        url: draft.media_path,
        prefer_large_media: true,
        show_above_text: true,
      },
    });
  }
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

function draftKeyboard(draftId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Опубликовать", `pub:${draftId}`)
    .text("❌ Пропустить", `skip:${draftId}`);
}

export async function sendDraftToAdmin(draft: Draft): Promise<void> {
  const msg = await sendPost(
    adminChatId(),
    draft,
    renderDraftPreview(draft),
    draftKeyboard(draft.id),
  );
  setAdminMsgId(draft.id, msg.message_id);
}

/** Публикация в канал: запоминаем message_id, чистим локальное медиа. */
export async function publishDraft(draft: Draft): Promise<void> {
  const msg = await sendPost(config.channelId, draft, renderPost(draft));
  setChannelMsgId(draft.id, msg.message_id);
  setDraftStatus(draft.id, "published");
  bumpStat("published");
  await cleanupMedia(draft);
}

async function notifyAutoPublished(draft: Draft): Promise<void> {
  const keyboard = new InlineKeyboard().text("🗑 Убрать из канала", `del:${draft.id}`);
  await bot.api.sendMessage(
    adminChatId(),
    `🚀 <b>Опубликовано автоматически</b> · #${draft.id} · ${draft.category} · ${draft.tone}\n\n${renderPost(draft)}`,
    { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } },
  );
}

/** Единая точка доставки черновика: автопубликация или модерация. */
export async function deliverDraft(draft: Draft): Promise<void> {
  if (config.autoPublish) {
    try {
      await publishDraft(draft);
      await notifyAutoPublished(draft);
      return;
    } catch (err) {
      console.error(`Черновик #${draft.id}: автопубликация не удалась, шлю на модерацию:`, err);
    }
  }
  await sendDraftToAdmin(draft);
}

/** Обновляет уже опубликованный пост в канале (например, добавился источник сюжета). */
export async function refreshChannelPost(draftId: number): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft || draft.status !== "published" || !draft.channel_msg_id) return;
  const text = renderPost(draft);
  try {
    if (draft.media_type === "video_link" && draft.media_path) {
      await bot.api.editMessageText(config.channelId, draft.channel_msg_id, text, {
        parse_mode: "HTML",
        link_preview_options: {
          url: draft.media_path,
          prefer_large_media: true,
          show_above_text: true,
        },
      });
    } else if (draft.media_type) {
      await bot.api.editMessageCaption(config.channelId, draft.channel_msg_id, {
        parse_mode: "HTML",
        caption: text,
      });
    } else {
      await bot.api.editMessageText(config.channelId, draft.channel_msg_id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  } catch (err) {
    console.error(`Черновик #${draftId}: не удалось обновить пост в канале:`, err);
  }
}

/** Обновляет превью черновика в личке (например, когда к сюжету добавился источник). */
export async function refreshDraftPreview(draftId: number): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft || draft.status !== "pending" || !draft.admin_msg_id) return;
  const text = renderDraftPreview(draft);
  const opts = { parse_mode: "HTML" as const, reply_markup: draftKeyboard(draft.id) };
  try {
    if (draft.media_type === "video_link" && draft.media_path) {
      await bot.api.editMessageText(adminChatId(), draft.admin_msg_id, text, {
        ...opts,
        link_preview_options: {
          url: draft.media_path,
          prefer_large_media: true,
          show_above_text: true,
        },
      });
    } else if (draft.media_path) {
      await bot.api.editMessageCaption(adminChatId(), draft.admin_msg_id, {
        ...opts,
        caption: text,
      });
    } else {
      await bot.api.editMessageText(adminChatId(), draft.admin_msg_id, text, {
        ...opts,
        link_preview_options: { is_disabled: true },
      });
    }
  } catch (err) {
    console.error(`Черновик #${draftId}: не удалось обновить превью:`, err);
  }
}

export async function sendScoutCandidateToAdmin(c: ScoutCandidate): Promise<void> {
  const label = c.kind === "channel" ? `Telegram-канал @${c.ref}` : `RSS-фид ${c.ref}`;
  const link = c.kind === "channel" ? `https://t.me/${c.ref}` : c.ref;
  const keyboard = new InlineKeyboard()
    .text("➕ Добавить", `scoutadd:${c.id}`)
    .text("🚫 Не надо", `scoutno:${c.id}`);
  await bot.api.sendMessage(
    adminChatId(),
    `🔭 <b>Скаут нашёл источник</b>\n\n${escapeHtml(label)}\n${escapeHtml(c.note)}\n\n<a href="${link}">Посмотреть</a>`,
    { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } },
  );
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
      await publishDraft(draft);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.answerCallbackQuery({ text: "Не смог опубликовать", show_alert: true });
      await ctx.reply(
        `Публикация не удалась: ${reason}\n\nПроверь CHANNEL_ID в .env — там должен быть юзернейм канала (не бота), а бот — админом канала с правом публикации. После правки перезапусти bun start и нажми кнопку ещё раз.`,
      );
      return;
    }
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

bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Не твоя кнопка" });
    return;
  }
  const draft = getDraft(Number(ctx.match[1]));
  if (!draft?.channel_msg_id) {
    await ctx.answerCallbackQuery({ text: "Пост не найден" });
    return;
  }
  try {
    await bot.api.deleteMessage(config.channelId, draft.channel_msg_id);
  } catch (err) {
    // боты не могут удалять посты старше 48 часов
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({ text: "Не смог удалить", show_alert: true });
    await ctx.reply(`Удаление не удалось: ${reason}`);
    return;
  }
  setDraftStatus(draft.id, "retracted");
  bumpStat("retracted");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.answerCallbackQuery({ text: "Убрано из канала" });
  await ctx.reply(`🗑 Пост #${draft.id} убран из канала`);
});

function renderStats(): string {
  const fmt = (s: Record<string, number>): string =>
    [
      `собрано ${s.gathered ?? 0}`,
      `триаж-отсев ${s.triage_out ?? 0}`,
      `фильтр-отсев ${s.classify_drop ?? 0}`,
      `квота негатива ${s.quota_drop ?? 0}`,
      `в сюжеты ${s.merged ?? 0}`,
      `черновиков ${s.drafted ?? 0}`,
      `опубликовано ${s.published ?? 0}`,
      ...(s.retracted ? [`убрано ${s.retracted}`] : []),
    ].join(" · ");

  const lines = [
    "📊 <b>Статистика</b>",
    "",
    `<b>Сегодня:</b> ${fmt(statsRange(1))}`,
    `<b>7 дней:</b> ${fmt(statsRange(7))}`,
  ];

  const cats = publishedByCategory(7);
  if (cats.length > 0) {
    lines.push(
      "",
      `<b>Опубликовано по категориям (7 дн):</b> ${cats.map((c) => `${c.category} ${c.n}`).join(" · ")}`,
    );
  }

  const engagement = engagementByCategory(14)
    .filter((e) => e.views > 0)
    .map((e) => ({ ...e, rate: (e.reactions + e.forwards) / e.views }))
    .sort((a, b) => b.rate - a.rate);
  if (engagement.length > 0) {
    const total = engagement.reduce((s, e) => s + e.views, 0);
    lines.push(
      "",
      `<b>Вовлечённость (14 дн, ${total} 👀):</b> ${engagement
        .map((e) => `${e.category} ${(e.rate * 100).toFixed(1)}%`)
        .join(" · ")}`,
    );
  }

  return lines.join("\n");
}

bot.callbackQuery(/^(scoutadd|scoutno):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Не твоя кнопка" });
    return;
  }
  const action = ctx.match[1];
  const candidate = getScoutCandidate(Number(ctx.match[2]));
  if (!candidate) {
    await ctx.answerCallbackQuery({ text: "Кандидат не найден" });
    return;
  }
  if (candidate.status !== "pending") {
    await ctx.answerCallbackQuery({ text: `Уже обработан: ${candidate.status}` });
    return;
  }
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  if (action === "scoutadd") {
    const added = await addSource(
      candidate.kind as "channel" | "rss",
      candidate.ref,
      candidate.note,
    );
    setScoutStatus(candidate.id, "added");
    await ctx.answerCallbackQuery({ text: "Добавлен" });
    await ctx.reply(
      added
        ? `➕ Источник ${candidate.ref} добавлен — подхватится в следующем цикле`
        : `Источник ${candidate.ref} уже был в списке`,
    );
  } else {
    setScoutStatus(candidate.id, "rejected");
    await ctx.answerCallbackQuery({ text: "Ок, не буду предлагать снова" });
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
  scoutNow: () => Promise<number>,
): void {
  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    await ctx.reply(renderStats(), { parse_mode: "HTML" });
  });

  bot.command("scout", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    await ctx.reply("Ищу новые источники (займёт минуту)…");
    try {
      const sent = await scoutNow();
      await ctx.reply(sent > 0 ? `Нашёл ${sent} кандидатов — смотри выше` : "Новых кандидатов нет");
    } catch (err) {
      await ctx.reply(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("rubric", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const kind = ctx.match?.trim() === "activity" ? "activity" : "place";
    await ctx.reply(`Генерирую рубрику (${kind})…`);
    try {
      const draft = await makeRubric(kind);
      if (draft) {
        await deliverDraft(draft);
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
      "Я собираю новости из источников, фильтрую через LLM, склеиваю дубли в сюжеты и публикую (или присылаю на модерацию). /check — проверить источники, /rubric [place|activity] — рубрика, /scout — поиск новых источников, /stats — статистика.",
    );
  });
}
