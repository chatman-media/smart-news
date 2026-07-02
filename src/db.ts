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

export interface Draft {
  id: number;
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
  created_at: string;
}

export function getLastMsgId(username: string): number {
  const row = db
    .query<{ last_msg_id: number }, [string]>(
      "SELECT last_msg_id FROM channel_state WHERE username = ?",
    )
    .get(username);
  return row?.last_msg_id ?? 0;
}

export function setLastMsgId(username: string, msgId: number): void {
  db.run(
    `INSERT INTO channel_state (username, last_msg_id) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET last_msg_id = MAX(last_msg_id, excluded.last_msg_id)`,
    [username, msgId],
  );
}

export function insertDraft(
  d: Omit<Draft, "id" | "status" | "admin_msg_id" | "created_at">,
): Draft | null {
  const row = db
    .query<
      Draft,
      [string, number, string, string, string, string, number, string, string | null, string | null]
    >(
      `INSERT INTO drafts (source, source_msg_id, link, title, summary, category, importance, tone, media_type, media_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, source_msg_id) DO NOTHING
       RETURNING *`,
    )
    .get(
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

export function isRssSeen(feed: string, guid: string): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM rss_seen WHERE feed = ? AND guid = ?",
    )
    .get(feed, guid);
  return (row?.n ?? 0) > 0;
}

export function markRssSeen(feed: string, guid: string): void {
  db.run("INSERT INTO rss_seen (feed, guid) VALUES (?, ?) ON CONFLICT DO NOTHING", [feed, guid]);
}

/** Доля негативных постов среди новостных черновиков за последние N дней (0..1). */
export function negativeShare(days = 7): number {
  const row = db
    .query<{ total: number; negative: number }, [string]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN tone = 'negative' THEN 1 ELSE 0 END) AS negative
       FROM drafts
       WHERE source != 'rubric' AND status != 'skipped'
         AND created_at >= datetime('now', ?)`,
    )
    .get(`-${days} days`);
  if (!row || row.total === 0) return 0;
  return row.negative / row.total;
}

/** Была ли уже сегодня сгенерирована рубрика. */
export function hasRubricToday(): boolean {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM drafts
       WHERE source = 'rubric' AND date(created_at) = date('now')`,
    )
    .get();
  return (row?.n ?? 0) > 0;
}

/** Категория последней рубрики — чтобы чередовать «место» и «занятие». */
export function lastRubricCategory(): string | null {
  const row = db
    .query<{ category: string }, []>(
      "SELECT category FROM drafts WHERE source = 'rubric' ORDER BY id DESC LIMIT 1",
    )
    .get();
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
export function recentStories(hours = 72): StoryCandidate[] {
  const rows = db
    .query<{ id: number; title: string; status: string; embedding: Uint8Array | null }, [string]>(
      `SELECT id, title, status, embedding FROM drafts
       WHERE source != 'rubric' AND embedding IS NOT NULL
         AND created_at >= datetime('now', ?)
       ORDER BY id DESC LIMIT 200`,
    )
    .all(`-${hours} hours`);
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
  kind: string;
  ref: string;
  note: string;
  status: string;
}

/** null, если такой кандидат уже был (не предлагаем повторно). */
export function insertScoutCandidate(
  kind: string,
  ref: string,
  note: string,
): ScoutCandidate | null {
  return (
    db
      .query<ScoutCandidate, [string, string, string]>(
        `INSERT INTO scout_candidates (kind, ref, note) VALUES (?, ?, ?)
         ON CONFLICT(kind, ref) DO NOTHING RETURNING *`,
      )
      .get(kind, ref, note) ?? null
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
