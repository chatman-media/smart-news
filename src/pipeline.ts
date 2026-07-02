import type { Message, TelegramClient } from "@mtcute/bun";
import { sendDraftToAdmin } from "./bot";
import { classify, type Verdict } from "./classify";
import { config } from "./config";
import {
  getLastMsgId,
  insertDraft,
  isRssSeen,
  markRssSeen,
  negativeShare,
  recentTitles,
  setLastMsgId,
} from "./db";
import { fetchFeedItems, guidToId } from "./rss";
import { loadFeeds, loadSources } from "./sources";

let running = false;

/** Один проход: источники → новые посты → фильтр Claude → черновики админу. Возвращает число новых черновиков. */
export async function runPipeline(tg: TelegramClient): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const fromTelegram = await ingestTelegram(tg);
    const fromRss = await ingestRss();
    return fromTelegram + fromRss;
  } finally {
    running = false;
  }
}

export interface PostMedia {
  type: "photo" | "video";
  path: string;
}

/** Классификация + квота негатива + черновик. Медиа качается лениво — только для прошедших фильтр. */
async function processPost(post: {
  source: string;
  sourceMsgId: number;
  link: string;
  text: string;
  label: string;
  fetchMedia?: () => Promise<PostMedia | null>;
}): Promise<boolean> {
  const verdict: Verdict = await classify(post.text, recentTitles());
  // Квота негатива: критичные предупреждения (importance 5) проходят всегда
  if (
    verdict.keep &&
    verdict.tone === "negative" &&
    verdict.importance < 5 &&
    negativeShare() * 100 >= config.negativeQuotaPct
  ) {
    verdict.keep = false;
    verdict.reason = "negative_quota";
  }
  if (!verdict.keep) {
    console.log(`[${post.label}] отфильтровано: ${verdict.reason}`);
    return false;
  }
  let media: PostMedia | null = null;
  try {
    media = (await post.fetchMedia?.()) ?? null;
  } catch (err) {
    console.error(`[${post.label}] медиа не скачалось, пост уйдёт текстом:`, err);
  }
  const draft = insertDraft({
    source: post.source,
    source_msg_id: post.sourceMsgId,
    link: post.link,
    title: verdict.title,
    summary: verdict.summary,
    category: verdict.category,
    importance: verdict.importance,
    tone: verdict.tone,
    media_type: media?.type ?? null,
    media_path: media?.path ?? null,
  });
  if (!draft) return false;
  await sendDraftToAdmin(draft);
  return true;
}

const MAX_VIDEO_BYTES = 45 * 1024 * 1024; // лимит Bot API на выгрузку — 50 МБ, берём с запасом

async function downloadTelegramMedia(
  tg: TelegramClient,
  source: string,
  msg: Message,
): Promise<PostMedia | null> {
  const media = msg.media;
  if (!media) return null;
  if (media.type === "photo") {
    const path = `data/media/${source}_${msg.id}.jpg`;
    await tg.downloadToFile(path, media);
    return { type: "photo", path };
  }
  if (media.type === "video") {
    if ((media.fileSize ?? 0) > MAX_VIDEO_BYTES) {
      console.log(`[${source}/${msg.id}] видео больше 45 МБ — пост уйдёт текстом`);
      return null;
    }
    const path = `data/media/${source}_${msg.id}.mp4`;
    await tg.downloadToFile(path, media);
    return { type: "video", path };
  }
  return null;
}

async function ingestTelegram(tg: TelegramClient): Promise<number> {
  const sources = await loadSources();
  let newDrafts = 0;

  for (const source of sources) {
    const lastId = getLastMsgId(source.username);
    const limit = lastId === 0 ? config.firstRunLimit : config.perCycleLimit;

    const messages: Message[] = [];
    try {
      for await (const msg of tg.iterHistory(source.username, { limit, minId: lastId })) {
        messages.push(msg);
      }
    } catch (err) {
      console.error(`[${source.username}] не удалось получить историю:`, err);
      continue;
    }

    // iterHistory отдаёт от новых к старым — обрабатываем по порядку
    messages.sort((a, b) => a.id - b.id);

    for (const msg of messages) {
      if ((msg.text ?? "").trim().length < config.minPostLength) {
        setLastMsgId(source.username, msg.id);
        continue;
      }

      try {
        if (
          await processPost({
            source: source.username,
            sourceMsgId: msg.id,
            link: `https://t.me/${source.username}/${msg.id}`,
            text: msg.text ?? "",
            label: `${source.username}/${msg.id}`,
            fetchMedia: () => downloadTelegramMedia(tg, source.username, msg),
          })
        ) {
          newDrafts++;
        }
        // Помечаем прочитанным только после успешной обработки — при сбое повторим в следующем цикле
        setLastMsgId(source.username, msg.id);
      } catch (err) {
        console.error(`[${source.username}/${msg.id}] ошибка классификации:`, err);
        break; // остальное в этом канале догоним следующим циклом
      }
    }
  }

  return newDrafts;
}

async function ingestRss(): Promise<number> {
  const feeds = await loadFeeds();
  let newDrafts = 0;

  for (const feed of feeds) {
    let items: Awaited<ReturnType<typeof fetchFeedItems>>;
    try {
      items = await fetchFeedItems(feed, config.rssPerCycleLimit);
    } catch (err) {
      console.error(`[rss:${feed.name}] не удалось получить фид:`, err);
      continue;
    }

    const fresh = items.filter((item) => !isRssSeen(feed.name, item.guid));
    // Первый запуск фида: не разбираем весь архив
    const isFirstRun = fresh.length === items.length && items.length > 0;
    const batch = isFirstRun ? fresh.slice(0, config.rssFirstRunLimit) : fresh;
    if (isFirstRun) {
      for (const item of fresh.slice(config.rssFirstRunLimit)) {
        markRssSeen(feed.name, item.guid);
      }
    }

    // RSS отдаёт от новых к старым — публикуем по порядку
    batch.reverse();

    for (const item of batch) {
      if (item.text.trim().length < config.minPostLength) {
        markRssSeen(feed.name, item.guid);
        continue;
      }
      try {
        if (
          await processPost({
            source: `rss:${feed.name}`,
            sourceMsgId: guidToId(item.guid),
            link: item.link,
            text: item.text,
            label: `rss:${feed.name} ${item.link}`,
            fetchMedia: async () => (item.imageUrl ? { type: "photo", path: item.imageUrl } : null),
          })
        ) {
          newDrafts++;
        }
        markRssSeen(feed.name, item.guid);
      } catch (err) {
        console.error(`[rss:${feed.name}] ошибка классификации:`, err);
        break; // догоним следующим циклом
      }
    }
  }

  return newDrafts;
}
