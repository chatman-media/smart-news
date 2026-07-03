// Скаут источников: раз в неделю ищет новые каналы/фиды через веб-поиск и предлагает их админу.
import type { TelegramClient } from "@mtcute/bun";
import { sendScoutCandidateToAdmin } from "./bot";
import { config } from "./config";
import {
  type Channel,
  insertScoutCandidate,
  kvGet,
  kvSet,
  listChannels,
  listChannelSources,
} from "./db";
import { contentOf, llm, parseJsonLoose } from "./llm";
import { fetchFeedItems } from "./rss";

const SCOUT_INTERVAL_DAYS = 7;

interface RawCandidate {
  kind: "channel" | "rss";
  ref: string;
  note: string;
}

const SCOUT_PROMPT = (focus: string, known: string[]) => `Найди через веб-поиск действующие источники новостей для аудитории: ${focus}.
- публичные Telegram-каналы (новости, а не чаты и не боты) — на любых языках
- RSS-фиды местных изданий (проверяй, что у издания есть RSS: обычно /feed или /rss)

Уже подключены (не предлагай): ${known.join(", ") || "пока ничего"}.

Ответь строго JSON без пояснений:
{"candidates": [{"kind": "channel"|"rss", "ref": "<username без @ | полный URL фида>", "note": "<что это, на каком языке, чем полезно — одной строкой>"}]}
Максимум 6 кандидатов, только те, в существовании которых уверен.`;

async function findCandidates(focus: string, known: string[]): Promise<RawCandidate[]> {
  const response = await llm.chat.completions.create({
    model: `${config.llmModel}:online`,
    // с большим запасом: reasoning + результаты веб-поиска едят лимит до ответа
    max_tokens: 8000,
    messages: [{ role: "user", content: SCOUT_PROMPT(focus, known) }],
  });
  const parsed = parseJsonLoose<{ candidates: RawCandidate[] }>(contentOf(response));
  return Array.isArray(parsed.candidates) ? parsed.candidates : [];
}

async function isAlive(tg: TelegramClient, c: RawCandidate): Promise<boolean> {
  try {
    if (c.kind === "channel") {
      for await (const _ of tg.iterHistory(c.ref, { limit: 1 })) return true;
      return false;
    }
    const items = await fetchFeedItems({ name: "probe", url: c.ref }, 3);
    return items.length > 0;
  } catch {
    return false;
  }
}

/** Прогон скаута для одного канала. Возвращает число новых кандидатов, отправленных админу. */
export async function runScout(tg: TelegramClient, channel: Channel): Promise<number> {
  const sources = listChannelSources(channel.id);
  const known = new Set(sources.map((s) => s.ref.toLowerCase()));
  const knownNames = sources.map((s) => s.name || s.ref);

  const found = await findCandidates(channel.focus, knownNames);
  let sent = 0;
  for (const raw of found) {
    if (raw.kind !== "channel" && raw.kind !== "rss") continue;
    const ref =
      raw.kind === "channel"
        ? raw.ref
            .trim()
            .replace(/^https?:\/\/t\.me\/(s\/)?/i, "")
            .replace(/^@/, "")
            .replace(/\/.*$/, "")
        : raw.ref.trim();
    if (!ref || known.has(ref.toLowerCase()) || known.has(ref)) continue;
    if (!(await isAlive(tg, { ...raw, ref }))) {
      console.log(`[scout] кандидат ${ref} не отвечает — пропускаю`);
      continue;
    }
    const candidate = insertScoutCandidate(channel.id, raw.kind, ref, raw.note ?? "");
    if (!candidate) continue; // уже предлагали
    await sendScoutCandidateToAdmin(candidate);
    sent++;
  }
  return sent;
}

/** Скаут по всем активным каналам. */
export async function runScoutAll(tg: TelegramClient): Promise<number> {
  let sent = 0;
  for (const channel of listChannels(true)) {
    sent += await runScout(tg, channel).catch((err) => {
      console.error(`[scout] канал «${channel.name}» упал:`, err);
      return 0;
    });
  }
  return sent;
}

/** Еженедельный запуск из основного цикла. */
export async function maybeRunWeeklyScout(tg: TelegramClient): Promise<void> {
  const last = kvGet("last_scout_at");
  if (last && Date.now() - Date.parse(last) < SCOUT_INTERVAL_DAYS * 24 * 3600 * 1000) return;
  kvSet("last_scout_at", new Date().toISOString());
  const sent = await runScoutAll(tg);
  console.log(`[scout] прогон завершён: ${sent} новых кандидатов`);
}
