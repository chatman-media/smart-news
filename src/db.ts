import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });

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
    status TEXT NOT NULL DEFAULT 'pending',
    admin_msg_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, source_msg_id)
  );

  CREATE TABLE IF NOT EXISTS rubric_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    topic TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE(kind, topic)
  );
`);

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
    .query<Draft, [string, number, string, string, string, string, number, string]>(
      `INSERT INTO drafts (source, source_msg_id, link, title, summary, category, importance, tone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, source_msg_id) DO NOTHING
       RETURNING *`,
    )
    .get(d.source, d.source_msg_id, d.link, d.title, d.summary, d.category, d.importance, d.tone);
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

/** Заголовки недавних черновиков — для дедупликации на стороне LLM. */
export function recentTitles(limit = 30): string[] {
  const rows = db
    .query<{ title: string }, [number]>("SELECT title FROM drafts ORDER BY id DESC LIMIT ?")
    .all(limit);
  return rows.map((r) => r.title);
}
