import type { Message, TelegramClient } from "@mtcute/bun";
import { deliverDraft, refreshChannelPost, refreshDraftPreview } from "./bot";
import { classify, confirmStory, triage, type Verdict } from "./classify";
import { config } from "./config";
import {
  addDraftSource,
  getLastMsgId,
  insertDraft,
  isRssSeen,
  markRssSeen,
  negativeShare,
  recentStories,
  setDraftEmbedding,
  setLastMsgId,
} from "./db";
import { cosine, embed } from "./llm";
import { fetchFeedItems, guidToId } from "./rss";
import { loadFeeds, loadSources } from "./sources";

let running = false;

/** Один проход: сбор нового → дешёвый триаж заголовков → полная классификация → склейка сюжетов → черновики. */
export async function runPipeline(tg: TelegramClient): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const posts = [...(await gatherTelegram(tg)), ...(await gatherRss())];
    if (posts.length === 0) return 0;
    const candidates = await triagePosts(posts);
    let newDrafts = 0;
    for (const post of candidates) {
      if (await processCandidate(post)) newDrafts++;
    }
    return newDrafts;
  } finally {
    running = false;
  }
}

export interface PostMedia {
  type: "photo" | "video";
  path: string;
}

interface NewPost {
  source: string;
  sourceMsgId: number;
  link: string;
  text: string;
  headline: string;
  label: string;
  markSeen: () => void;
  fetchMedia?: () => Promise<PostMedia | null>;
}

const TRIAGE_CHUNK = 25;

/** Триаж-батчи: отсеянное сразу помечается прочитанным, кандидаты идут дальше. */
async function triagePosts(posts: NewPost[]): Promise<NewPost[]> {
  const candidates: NewPost[] = [];
  for (let offset = 0; offset < posts.length; offset += TRIAGE_CHUNK) {
    const chunk = posts.slice(offset, offset + TRIAGE_CHUNK);
    let keep: Set<number>;
    try {
      keep = await triage(
        chunk.map((p, i) => ({ index: i, headline: `[${p.source}] ${p.headline}` })),
      );
    } catch (err) {
      console.error("Триаж упал, батч уйдёт на повтор в следующем цикле:", err);
      continue; // ничего не помечаем — повторим
    }
    chunk.forEach((post, i) => {
      if (keep.has(i)) {
        candidates.push(post);
      } else {
        console.log(`[${post.label}] триаж: мимо`);
        post.markSeen();
      }
    });
  }
  console.log(`Триаж: ${candidates.length} кандидатов из ${posts.length}`);
  return candidates;
}

/** Полная классификация кандидата + квота негатива + склейка сюжетов + черновик. */
async function processCandidate(post: NewPost): Promise<boolean> {
  let verdict: Verdict;
  try {
    verdict = await classify(post.text);
  } catch (err) {
    console.error(`[${post.label}] ошибка классификации (повторим в следующем цикле):`, err);
    return false; // markSeen не зовём — пост вернётся
  }
  post.markSeen();

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

  // Склейка сюжетов: embedding по русской выжимке + LLM-подтверждение пограничных
  let vector: Float32Array | null = null;
  try {
    vector = await embed(`${verdict.title}\n${verdict.summary}`);
    const storyId = await matchStory(verdict, vector);
    if (storyId) {
      addDraftSource(storyId, post.source, post.link);
      await refreshDraftPreview(storyId); // если сюжет ещё на модерации
      await refreshChannelPost(storyId); // если уже опубликован
      console.log(`[${post.label}] влит в сюжет #${storyId}`);
      return false;
    }
  } catch (err) {
    console.error(`[${post.label}] дедуп сюжетов не сработал, публикую как новый:`, err);
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
  if (vector) setDraftEmbedding(draft.id, vector);
  await deliverDraft(draft);
  return true;
}

const SIM_AUTO = 0.92; // выше — дубль без вопросов
const SIM_CHECK = 0.6; // выше — спрашиваем LLM

async function matchStory(
  verdict: { title: string; summary: string },
  vector: Float32Array,
): Promise<number | null> {
  const scored = recentStories()
    .map((s) => ({ ...s, sim: cosine(vector, s.embedding) }))
    .filter((s) => s.sim >= SIM_CHECK)
    .sort((a, b) => b.sim - a.sim);
  if (scored.length === 0) return null;
  const best = scored[0];
  if (best && best.sim >= SIM_AUTO) return best.id;
  return await confirmStory(verdict, scored.slice(0, 3));
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

async function gatherTelegram(tg: TelegramClient): Promise<NewPost[]> {
  const sources = await loadSources();
  const posts: NewPost[] = [];

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
      const text = (msg.text ?? "").trim();
      if (text.length < config.minPostLength) {
        setLastMsgId(source.username, msg.id);
        continue;
      }
      posts.push({
        source: source.username,
        sourceMsgId: msg.id,
        link: `https://t.me/${source.username}/${msg.id}`,
        text,
        headline: text.split("\n")[0]?.slice(0, 120) ?? "",
        label: `${source.username}/${msg.id}`,
        markSeen: () => setLastMsgId(source.username, msg.id),
        fetchMedia: () => downloadTelegramMedia(tg, source.username, msg),
      });
    }
  }

  return posts;
}

async function gatherRss(): Promise<NewPost[]> {
  const feeds = await loadFeeds();
  const posts: NewPost[] = [];

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

    // RSS отдаёт от новых к старым — обрабатываем по порядку
    batch.reverse();

    for (const item of batch) {
      if (item.text.trim().length < config.minPostLength) {
        markRssSeen(feed.name, item.guid);
        continue;
      }
      posts.push({
        source: `rss:${feed.name}`,
        sourceMsgId: guidToId(item.guid),
        link: item.link,
        text: item.text,
        headline: item.title.slice(0, 120),
        label: `rss:${feed.name} ${item.link}`,
        markSeen: () => markRssSeen(feed.name, item.guid),
        fetchMedia: async () => (item.imageUrl ? { type: "photo", path: item.imageUrl } : null),
      });
    }
  }

  return posts;
}
