// Скаут источников: раз в неделю ищет новые каналы/фиды через веб-поиск и предлагает их админу.
import type { TelegramClient } from "@mtcute/bun";
import { sendScoutCandidateToAdmin } from "./bot";
import { config } from "./config";
import { insertScoutCandidate, kvGet, kvSet } from "./db";
import { contentOf, llm, parseJsonLoose } from "./llm";
import { fetchFeedItems } from "./rss";
import { loadFeeds, loadSources } from "./sources";

const SCOUT_INTERVAL_DAYS = 7;

interface RawCandidate {
  kind: "channel" | "rss";
  ref: string;
  note: string;
}

const SCOUT_PROMPT = `Найди через веб-поиск действующие источники новостей о Пхукете и Таиланде, полезные русскоязычным экспатам:
- публичные Telegram-каналы (новости, а не чаты и не боты) — русские, английские, тайские
- RSS-фиды местных изданий (проверяй, что у издания есть RSS: обычно /feed или /rss)

Не предлагай: The Thaiger, Khaosod, Bangkok Post, «Новости Пхукета», «Реальный Пхукет» — они уже подключены.

Ответь строго JSON без пояснений:
{"candidates": [{"kind": "channel"|"rss", "ref": "<username без @ | полный URL фида>", "note": "<что это, на каком языке, чем полезно — одной строкой>"}]}
Максимум 6 кандидатов, только те, в существовании которых уверен.`;

async function findCandidates(): Promise<RawCandidate[]> {
  const response = await llm.chat.completions.create({
    model: `${config.llmModel}:online`,
    max_tokens: 2000,
    messages: [{ role: "user", content: SCOUT_PROMPT }],
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

/** Один прогон скаута. Возвращает число новых кандидатов, отправленных админу. */
export async function runScout(tg: TelegramClient): Promise<number> {
  const [channels, feeds] = [await loadSources(), await loadFeeds()];
  const known = new Set([
    ...channels.map((c) => c.username.toLowerCase()),
    ...feeds.map((f) => f.url),
  ]);

  const found = await findCandidates();
  let sent = 0;
  for (const raw of found) {
    if (raw.kind !== "channel" && raw.kind !== "rss") continue;
    const ref = raw.kind === "channel" ? raw.ref.replace(/^@/, "").trim() : raw.ref.trim();
    if (!ref || known.has(ref.toLowerCase()) || known.has(ref)) continue;
    if (!(await isAlive(tg, { ...raw, ref }))) {
      console.log(`[scout] кандидат ${ref} не отвечает — пропускаю`);
      continue;
    }
    const candidate = insertScoutCandidate(raw.kind, ref, raw.note ?? "");
    if (!candidate) continue; // уже предлагали
    await sendScoutCandidateToAdmin(candidate);
    sent++;
  }
  return sent;
}

/** Еженедельный запуск из основного цикла. */
export async function maybeRunWeeklyScout(tg: TelegramClient): Promise<void> {
  const last = kvGet("last_scout_at");
  if (last && Date.now() - Date.parse(last) < SCOUT_INTERVAL_DAYS * 24 * 3600 * 1000) return;
  kvSet("last_scout_at", new Date().toISOString());
  const sent = await runScout(tg);
  console.log(`[scout] прогон завершён: ${sent} новых кандидатов`);
}
