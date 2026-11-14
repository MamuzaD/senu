import { Database } from "bun:sqlite"
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout } from "node:timers/promises"

import { stateDir } from "~/paths.ts"

export interface Message {
  message_id: string
  from: string
  to: string
  text: string
  reply_to: string | null
  status: "pending" | "delivered" | "failed"
  created_at: number
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Shared by CLI and MCP processes; a pending delivery is never an available reply. */
export class MessageStore {
  private db: Database

  constructor(path = join(stateDir, "messages.sqlite")) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    closeSync(openSync(path, "a", 0o600))
    chmodSync(path, 0o600)
    this.db = new Database(path, { create: true })
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_replies ON messages(reply_to, status);
      CREATE TABLE IF NOT EXISTS waits (message_id TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS answers (message_id TEXT PRIMARY KEY, reply_id TEXT NOT NULL);
    `)
  }

  close() {
    this.db.close()
  }

  private get(id: string) {
    return this.db.query<Message, [string]>("SELECT * FROM messages WHERE message_id = ?").get(id)
  }

  sent(id: string, from: string, profiles: string[]) {
    const message = this.get(id)
    if (
      !message ||
      message.from !== from ||
      !profiles.some((profile) => message.to.startsWith(`${profile}:`))
    )
      throw new Error("Message not found in the caller's allowed conversations")
    if (message.status === "failed") throw new Error("Message delivery failed")
    return message
  }

  async send(
    from: string,
    to: string,
    text: string,
    replyTo: string | undefined,
    deliver: (id: string) => Promise<string>,
  ) {
    if (replyTo !== undefined) {
      const original = this.get(replyTo)
      if (!original || original.from !== to || original.to !== from || original.status === "failed")
        throw new Error("Reply target not found in this conversation")
    }
    const id = crypto.randomUUID()
    const awaited = this.db
      .transaction(() => {
        this.db.query("DELETE FROM messages WHERE created_at < ?").run(Date.now() - RETENTION_MS)
        this.db.exec(
          "DELETE FROM answers WHERE message_id NOT IN (SELECT message_id FROM messages)",
        )
        const waiting =
          replyTo !== undefined &&
          this.db
            .query("SELECT 1 FROM waits WHERE message_id = ? AND until > ?")
            .get(replyTo, Date.now()) !== null
        this.db
          .query(
            'INSERT INTO messages (message_id, "from", "to", text, reply_to, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(id, from, to, text, replyTo ?? null, waiting ? "delivered" : "pending", Date.now())
        return waiting
      })
      .immediate()
    if (awaited) return { message_id: id, delivery: "returned to the waiting sender" }
    try {
      const delivery = await deliver(id)
      this.db.query("UPDATE messages SET status = 'delivered' WHERE message_id = ?").run(id)
      return { message_id: id, delivery }
    } catch (error) {
      this.db.query("UPDATE messages SET status = 'failed' WHERE message_id = ?").run(id)
      throw error
    }
  }

  async waitForReply(
    id: string,
    from: string,
    profiles: string[],
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error("timeout_ms must be between 1 and 60000")
    this.sent(id, from, profiles)
    const until = Date.now() + timeoutMs
    const stopWaiting = () =>
      this.db.query("DELETE FROM waits WHERE message_id = ? AND until <= ?").run(id, until)
    this.db.query("DELETE FROM waits WHERE until <= ?").run(Date.now())
    this.db
      .query(
        `INSERT INTO waits (message_id, until) VALUES (?, ?)
         ON CONFLICT (message_id) DO UPDATE SET until = max(until, excluded.until)`,
      )
      .run(id, until)
    try {
      while (true) {
        signal?.throwIfAborted()
        const message = this.sent(id, from, profiles)
        const timedOut = Date.now() >= until
        if (timedOut) stopWaiting()
        const reply = message.status === "delivered" ? this.reply(message) : null
        if (reply)
          return {
            message_id: id,
            timed_out: false,
            reply: { message_id: reply.message_id, from: reply.from, text: reply.text },
          }
        if (timedOut) return { message_id: id, timed_out: true, reply: null }
        await setTimeout(Math.min(100, until - Date.now()), undefined, { signal })
      }
    } finally {
      stopWaiting()
    }
  }

  reply(message: Message) {
    const answer = () =>
      this.db
        .query<Message, [string]>(
          `SELECT messages.* FROM answers JOIN messages ON messages.message_id = answers.reply_id
           WHERE answers.message_id = ?`,
        )
        .get(message.message_id)
    const pinned = answer()
    if (pinned) return pinned
    const first = this.db
      .query<{ message_id: string }, [string, string, string]>(
        `SELECT message_id FROM messages WHERE reply_to = ? AND "from" = ? AND "to" = ?
         AND status = 'delivered' ORDER BY rowid LIMIT 1`,
      )
      .get(message.message_id, message.to, message.from)
    if (!first) return null
    this.db
      .query("INSERT OR IGNORE INTO answers (message_id, reply_id) VALUES (?, ?)")
      .run(message.message_id, first.message_id)
    return answer()
  }
}
