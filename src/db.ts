import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

mkdirSync("data/media", { recursive: true });

const db = new Database("data/news.db");
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS channel_state (
    username TEXT PRIMARY KEY,
    last_msg_id INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_msg_id INTEGER NOT NULL,
    link TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL,
    importance INTEGER NOT NULL,
    tone TEXT NOT NULL DEFAULT 'neutral',
    media_type TEXT,
    media_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_msg_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, source_msg_id)
  );

  CREATE TABLE IF NOT EXISTS rss_seen (
    feed TEXT NOT NULL,
    guid TEXT NOT NULL,
    seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (feed, guid)
  );

  CREATE TABLE IF NOT EXISTS rubric_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    topic TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE(kind, topic)
  );

  CREATE TABLE IF NOT EXISTS draft_sources (
    draft_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    link TEXT NOT NULL,
    PRIMARY KEY (draft_id, link)
  );

  CREATE TABLE IF NOT EXISTS scout_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(kind, ref)
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stats_daily (
    day TEXT NOT NULL,
    metric TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, metric)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    focus TEXT NOT NULL DEFAULT 'русскоязычные экспаты на Пхукете и в Таиланде',
    negative_quota INTEGER NOT NULL DEFAULT 20,
    auto_publish INTEGER NOT NULL DEFAULT 1,
    rubric_hour INTEGER NOT NULL DEFAULT 10,
    rubrics_enabled INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS channel_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(channel_id, kind, ref)
  );
`);

// Мягкая миграция для баз, созданных до появления колонки
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("drafts", "media_type", "media_type TEXT");
ensureColumn("drafts", "media_path", "media_path TEXT");
ensureColumn("drafts", "embedding", "embedding BLOB");
ensureColumn("drafts", "channel_msg_id", "channel_msg_id INTEGER");
ensureColumn("drafts", "views", "views INTEGER");
ensureColumn("drafts", "forwards", "forwards INTEGER");
ensureColumn("drafts", "reactions", "reactions INTEGER");
ensureColumn("drafts", "channel_id", "channel_id INTEGER NOT NULL DEFAULT 1");
ensureColumn("scout_candidates", "channel_id", "channel_id INTEGER NOT NULL DEFAULT 1");

// Одноразовая миграция single-channel → multi-channel: state получает префикс канала 1
if (
  db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM channel_state WHERE username NOT LIKE '%:%'",
    )
    .get()!.n > 0
) {
  db.run("UPDATE channel_state SET username = '1:' || username WHERE username NOT LIKE '%:%'");
}
if (
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rss_seen WHERE feed NOT LIKE '%:%'").get()!
    .n > 0
) {
  db.run("UPDATE OR IGNORE rss_seen SET feed = '1:' || feed WHERE feed NOT LIKE '%:%'");
}

export interface Channel {
  id: number;
  name: string;
  chat_id: string;
  focus: string;
  negative_quota: number;
  auto_publish: number;
  rubric_hour: number;
  rubrics_enabled: number;
  active: number;
}

export interface ChannelSource {
  id: number;
  channel_id: number;
  kind: string; // 'telegram' | 'rss'
  ref: string;
  name: string;
  note: string;
  active: number;
}

export function listChannels(onlyActive = false): Channel[] {
  return db
    .query<Channel, []>(
      `SELECT * FROM channels ${onlyActive ? "WHERE active = 1" : ""} ORDER BY id`,
    )
    .all();
}

export function getChannel(id: number): Channel | null {
  return db.query<Channel, [number]>("SELECT * FROM channels WHERE id = ?").get(id) ?? null;
}

export function createChannel(c: Omit<Channel, "id">): Channel {
  return db
    .query<Channel, [string, string, string, number, number, number, number, number]>(
      `INSERT INTO channels (name, chat_id, focus, negative_quota, auto_publish, rubric_hour, rubrics_enabled, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      c.name,
      c.chat_id,
      c.focus,
      c.negative_quota,
      c.auto_publish,
      c.rubric_hour,
      c.rubrics_enabled,
      c.active,
    ) as Channel;
}

const CHANNEL_FIELDS = new Set([
  "name",
  "chat_id",
  "focus",
  "negative_quota",
  "auto_publish",
  "rubric_hour",
  "rubrics_enabled",
  "active",
]);

export function updateChannel(id: number, patch: Record<string, unknown>): Channel | null {
  for (const [key, value] of Object.entries(patch)) {
    if (!CHANNEL_FIELDS.has(key)) continue;
    db.run(`UPDATE channels SET ${key} = ? WHERE id = ?`, [value as string | number, id]);
  }
  return getChannel(id);
}

export function listChannelSources(channelId: number, onlyActive = false): ChannelSource[] {
  return db
    .query<ChannelSource, [number]>(
      `SELECT * FROM channel_sources WHERE channel_id = ? ${onlyActive ? "AND active = 1" : ""} ORDER BY id`,
    )
    .all(channelId);
}

export function addChannelSource(
  channelId: number,
  kind: string,
  ref: string,
  name: string,
  note: string,
): ChannelSource | null {
  return (
    db
      .query<ChannelSource, [number, string, string, string, string]>(
        `INSERT INTO channel_sources (channel_id, kind, ref, name, note) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, kind, ref) DO NOTHING RETURNING *`,
      )
      .get(channelId, kind, ref, name, note) ?? null
  );
}

export function deleteChannelSource(id: number): void {
  db.run("DELETE FROM channel_sources WHERE id = ?", [id]);
}

export function setChannelSourceActive(id: number, active: boolean): void {
  db.run("UPDATE channel_sources SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
}

export function channelsCount(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM channels").get()?.n ?? 0;
}

export interface Draft {
  id: number;
  channel_id: number;
  source: string;
  source_msg_id: number;
  link: string;
  title: string;
  summary: string;
  category: string;
  importance: number;
  tone: string;
  media_type: string | null;
  media_path: string | null;
  status: string;
  admin_msg_id: number | null;
  channel_msg_id: number | null;
  created_at: string;
}

export function getLastMsgId(channelId: number, username: string): number {
  const row = db
    .query<{ last_msg_id: number }, [string]>(
      "SELECT last_msg_id FROM channel_state WHERE username = ?",
    )
    .get(`${channelId}:${username}`);
  return row?.last_msg_id ?? 0;
}

export function setLastMsgId(channelId: number, username: string, msgId: number): void {
  db.run(
    `INSERT INTO channel_state (username, last_msg_id) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET last_msg_id = MAX(last_msg_id, excluded.last_msg_id)`,
    [`${channelId}:${username}`, msgId],
  );
}

export function insertDraft(
  d: Omit<Draft, "id" | "status" | "admin_msg_id" | "channel_msg_id" | "created_at">,
): Draft | null {
  const row = db
    .query<
      Draft,
      [
        number,
        string,
        number,
        string,
        string,
        string,
        string,
        number,
        string,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO drafts (channel_id, source, source_msg_id, link, title, summary, category, importance, tone, media_type, media_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, source_msg_id) DO NOTHING
       RETURNING *`,
    )
    .get(
      d.channel_id,
      d.source,
      d.source_msg_id,
      d.link,
      d.title,
      d.summary,
      d.category,
      d.importance,
      d.tone,
      d.media_type,
      d.media_path,
    );
  return row ?? null;
}

export function getDraft(id: number): Draft | null {
  return db.query<Draft, [number]>("SELECT * FROM drafts WHERE id = ?").get(id) ?? null;
}

export function setDraftStatus(id: number, status: string): void {
  db.run("UPDATE drafts SET status = ? WHERE id = ?", [status, id]);
}

export function setAdminMsgId(id: number, adminMsgId: number): void {
  db.run("UPDATE drafts SET admin_msg_id = ? WHERE id = ?", [adminMsgId, id]);
}

export function setChannelMsgId(id: number, channelMsgId: number): void {
  db.run("UPDATE drafts SET channel_msg_id = ? WHERE id = ?", [channelMsgId, id]);
}

export function isRssSeen(channelId: number, feed: string, guid: string): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM rss_seen WHERE feed = ? AND guid = ?",
    )
    .get(`${channelId}:${feed}`, guid);
  return (row?.n ?? 0) > 0;
}

export function markRssSeen(channelId: number, feed: string, guid: string): void {
  db.run("INSERT INTO rss_seen (feed, guid) VALUES (?, ?) ON CONFLICT DO NOTHING", [
    `${channelId}:${feed}`,
    guid,
  ]);
}

/** Доля негативных постов среди новостных черновиков за последние N дней (0..1). */
export function negativeShare(channelId: number, days = 7): number {
  const row = db
    .query<{ total: number; negative: number }, [number, string]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN tone = 'negative' THEN 1 ELSE 0 END) AS negative
       FROM drafts
       WHERE channel_id = ? AND source != 'rubric' AND status != 'skipped'
         AND created_at >= datetime('now', ?)`,
    )
    .get(channelId, `-${days} days`);
  if (!row || row.total === 0) return 0;
  return row.negative / row.total;
}

/** Была ли уже сегодня сгенерирована рубрика. */
export function hasRubricToday(channelId: number): boolean {
  const row = db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM drafts
       WHERE channel_id = ? AND source = 'rubric' AND date(created_at) = date('now')`,
    )
    .get(channelId);
  return (row?.n ?? 0) > 0;
}

/** Категория последней рубрики — чтобы чередовать «место» и «занятие». */
export function lastRubricCategory(channelId: number): string | null {
  const row = db
    .query<{ category: string }, [number]>(
      "SELECT category FROM drafts WHERE channel_id = ? AND source = 'rubric' ORDER BY id DESC LIMIT 1",
    )
    .get(channelId);
  return row?.category ?? null;
}

export function seedRubricTopics(kind: string, topics: string[]): void {
  const stmt = db.prepare(
    "INSERT INTO rubric_topics (kind, topic) VALUES (?, ?) ON CONFLICT(kind, topic) DO NOTHING",
  );
  for (const topic of topics) stmt.run(kind, topic);
}

/** Самая давно не использованная тема рубрики. */
export function pickRubricTopic(kind: string): string | null {
  const row = db
    .query<{ topic: string }, [string]>(
      `SELECT topic FROM rubric_topics WHERE kind = ?
       ORDER BY last_used_at IS NOT NULL, last_used_at ASC, RANDOM() LIMIT 1`,
    )
    .get(kind);
  return row?.topic ?? null;
}

export function markRubricTopicUsed(kind: string, topic: string): void {
  db.run("UPDATE rubric_topics SET last_used_at = datetime('now') WHERE kind = ? AND topic = ?", [
    kind,
    topic,
  ]);
}

export function setDraftEmbedding(id: number, vector: Float32Array): void {
  db.run("UPDATE drafts SET embedding = ? WHERE id = ?", [
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    id,
  ]);
}

export interface StoryCandidate {
  id: number;
  title: string;
  status: string;
  embedding: Float32Array;
}

/** Недавние черновики с embedding — база для дедупа сюжетов. */
export function recentStories(channelId: number, hours = 72): StoryCandidate[] {
  const rows = db
    .query<
      { id: number; title: string; status: string; embedding: Uint8Array | null },
      [number, string]
    >(
      `SELECT id, title, status, embedding FROM drafts
       WHERE channel_id = ? AND source != 'rubric' AND embedding IS NOT NULL
         AND created_at >= datetime('now', ?)
       ORDER BY id DESC LIMIT 200`,
    )
    .all(channelId, `-${hours} hours`);
  return rows.map((r) => {
    const buf = r.embedding as Uint8Array;
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
    };
  });
}

export function addDraftSource(draftId: number, source: string, link: string): void {
  db.run(
    "INSERT INTO draft_sources (draft_id, source, link) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [draftId, source, link],
  );
}

export function listDraftSources(draftId: number): { source: string; link: string }[] {
  return db
    .query<{ source: string; link: string }, [number]>(
      "SELECT source, link FROM draft_sources WHERE draft_id = ? ORDER BY rowid",
    )
    .all(draftId);
}

export function kvGet(key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  db.run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export interface ScoutCandidate {
  id: number;
  channel_id: number;
  kind: string;
  ref: string;
  note: string;
  status: string;
}

/** null, если такой кандидат уже был (не предлагаем повторно). */
export function insertScoutCandidate(
  channelId: number,
  kind: string,
  ref: string,
  note: string,
): ScoutCandidate | null {
  return (
    db
      .query<ScoutCandidate, [number, string, string, string]>(
        `INSERT INTO scout_candidates (channel_id, kind, ref, note) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, ref) DO NOTHING RETURNING *`,
      )
      .get(channelId, kind, ref, note) ?? null
  );
}

export function getScoutCandidate(id: number): ScoutCandidate | null {
  return (
    db.query<ScoutCandidate, [number]>("SELECT * FROM scout_candidates WHERE id = ?").get(id) ??
    null
  );
}

export function setScoutStatus(id: number, status: string): void {
  db.run("UPDATE scout_candidates SET status = ? WHERE id = ?", [status, id]);
}

export function bumpStat(metric: string, by = 1): void {
  if (by <= 0) return;
  db.run(
    `INSERT INTO stats_daily (day, metric, value) VALUES (date('now'), ?, ?)
     ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value`,
    [metric, by],
  );
}

/** Суммы метрик за последние N дней (включая сегодня). */
export function statsRange(days: number): Record<string, number> {
  const rows = db
    .query<{ metric: string; total: number }, [string]>(
      `SELECT metric, SUM(value) AS total FROM stats_daily
       WHERE day >= date('now', ?) GROUP BY metric`,
    )
    .all(`-${days - 1} days`);
  return Object.fromEntries(rows.map((r) => [r.metric, r.total]));
}

export function publishedByCategory(days: number): { category: string; n: number }[] {
  return db
    .query<{ category: string; n: number }, [string]>(
      `SELECT category, COUNT(*) AS n FROM drafts
       WHERE status = 'published' AND created_at >= datetime('now', ?)
       GROUP BY category ORDER BY n DESC`,
    )
    .all(`-${days} days`);
}

/** Опубликованные посты для сбора вовлечённости. */
export function publishedForEngagement(
  channelId: number,
  days: number,
): { id: number; channel_msg_id: number }[] {
  return db
    .query<{ id: number; channel_msg_id: number }, [number, string]>(
      `SELECT id, channel_msg_id FROM drafts
       WHERE channel_id = ? AND status = 'published' AND channel_msg_id IS NOT NULL
         AND created_at >= datetime('now', ?)`,
    )
    .all(channelId, `-${days} days`);
}

export function updateEngagement(
  id: number,
  views: number,
  forwards: number,
  reactions: number,
): void {
  db.run("UPDATE drafts SET views = ?, forwards = ?, reactions = ? WHERE id = ?", [
    views,
    forwards,
    reactions,
    id,
  ]);
}

export function engagementByCategory(
  days: number,
): { category: string; views: number; forwards: number; reactions: number }[] {
  return db
    .query<{ category: string; views: number; forwards: number; reactions: number }, [string]>(
      `SELECT category, SUM(views) AS views, SUM(forwards) AS forwards, SUM(reactions) AS reactions
       FROM drafts
       WHERE status = 'published' AND views IS NOT NULL AND created_at >= datetime('now', ?)
       GROUP BY category`,
    )
    .all(`-${days} days`);
}
