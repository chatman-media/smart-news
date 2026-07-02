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
    status TEXT NOT NULL DEFAULT 'pending',
    admin_msg_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, source_msg_id)
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
    .query<Draft, [string, number, string, string, string, string, number]>(
      `INSERT INTO drafts (source, source_msg_id, link, title, summary, category, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, source_msg_id) DO NOTHING
       RETURNING *`,
    )
    .get(d.source, d.source_msg_id, d.link, d.title, d.summary, d.category, d.importance);
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

/** Заголовки недавних черновиков — для дедупликации на стороне LLM. */
export function recentTitles(limit = 30): string[] {
  const rows = db
    .query<{ title: string }, [number]>("SELECT title FROM drafts ORDER BY id DESC LIMIT ?")
    .all(limit);
  return rows.map((r) => r.title);
}
