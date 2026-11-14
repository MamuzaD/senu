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
  /** `offered` is a reply held for its waiting sender to claim */
  status: "pending" | "offered" | "delivered" | "failed"
  created_at: number
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CLAIM_WINDOW_MS = 1000

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
      CREATE TABLE IF NOT EXISTS servers (
        address TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );
    `)
  }

  close() {
    this.db.close()
  }

  /** Records the Senu version serving a session, for its peers' list_agents. */
  announce(address: string, version: string) {
    this.db.query("DELETE FROM servers WHERE seen_at < ?").run(Date.now() - RETENTION_MS)
    this.db
      .query(
        `INSERT INTO servers (address, version, seen_at) VALUES (?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET version = excluded.version, seen_at = excluded.seen_at`,
      )
      .run(address, version, Date.now())
  }

  versions(): Map<string, string> {
    return new Map(
      this.db
        .query<{ address: string; version: string }, []>("SELECT address, version FROM servers")
        .all()
        .map((s) => [s.address, s.version]),
    )
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

  /** Throws unless `replyTo` is a message `to` sent `from`. */
  checkReply(from: string, to: string, replyTo: string) {
    const original = this.get(replyTo)
    if (!original || original.from !== to || original.to !== from || original.status === "failed")
      throw new Error("Reply target not found in this conversation")
  }

  /** A message to a peer that is waiting on its sender is offered to that wait, as the reply to
   * the awaited message whether or not `replyTo` names it, and delivered as a new turn only if
   * the wait ends without claiming it. `waitMs` starts the sender's own wait before delivery, so
   * no reply can arrive ahead of it; such a message is a question, so without `replyTo` it
   * answers no wait. */
  async send(
    from: string,
    to: string,
    text: string,
    replyTo: string | undefined,
    deliver: (id: string) => Promise<string>,
    {
      claimWindowMs = CLAIM_WINDOW_MS,
      waitMs,
    }: { claimWindowMs?: number; waitMs?: number | undefined } = {},
  ) {
    if (replyTo !== undefined) this.checkReply(from, to, replyTo)
    const id = crypto.randomUUID()
    const awaited = this.db
      .transaction(() => {
        const now = Date.now()
        this.db.query("DELETE FROM messages WHERE created_at < ?").run(now - RETENTION_MS)
        this.db.exec(
          "DELETE FROM answers WHERE message_id NOT IN (SELECT message_id FROM messages)",
        )
        const awaitedByPeer =
          waitMs === undefined
            ? this.db
                .query<{ message_id: string }, [string, string, number]>(
                  `SELECT waits.message_id FROM waits JOIN messages USING (message_id)
                   WHERE messages."from" = ? AND messages."to" = ? AND waits.until > ?
                   AND waits.message_id NOT IN (SELECT message_id FROM answers)
                   ORDER BY messages.rowid DESC LIMIT 1`,
                )
                .get(to, from, now)?.message_id
            : undefined
        const waiting =
          replyTo === undefined
            ? awaitedByPeer !== undefined
            : this.db
                .query("SELECT 1 FROM waits WHERE message_id = ? AND until > ?")
                .get(replyTo, now) !== null
        this.db
          .query(
            'INSERT INTO messages (message_id, "from", "to", text, reply_to, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            from,
            to,
            text,
            replyTo ?? awaitedByPeer ?? null,
            waiting ? "offered" : "pending",
            now,
          )
        if (waitMs !== undefined)
          this.db.query("INSERT INTO waits (message_id, until) VALUES (?, ?)").run(id, now + waitMs)
        return waiting
      })
      .immediate()
    if (awaited) {
      const claimed = { message_id: id, delivery: "returned to the waiting sender" }
      for (const until = Date.now() + claimWindowMs; Date.now() < until; await setTimeout(20))
        if (this.get(id)?.status === "delivered") return claimed
      const withdrawn = this.db
        .query("UPDATE messages SET status = 'pending' WHERE message_id = ? AND status = 'offered'")
        .run(id).changes
      if (!withdrawn) return claimed
    }
    try {
      const delivery = await deliver(id)
      this.db.query("UPDATE messages SET status = 'delivered' WHERE message_id = ?").run(id)
      return { message_id: id, delivery }
    } catch (error) {
      this.db.query("UPDATE messages SET status = 'failed' WHERE message_id = ?").run(id)
      this.db.query("DELETE FROM waits WHERE message_id = ?").run(id)
      throw new Error(`Not delivered: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      })
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
        const reply = message.status === "delivered" ? this.replyOrFirstOffered(message) : null
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

  private replyOrFirstOffered(message: Message) {
    return this.db
      .transaction(() => {
        const reply = this.reply(message)
        if (reply) return reply
        this.db
          .query(
            `UPDATE messages SET status = 'delivered' WHERE message_id = (
               SELECT message_id FROM messages WHERE reply_to = ? AND "from" = ? AND "to" = ?
               AND status = 'offered' ORDER BY rowid LIMIT 1)`,
          )
          .run(message.message_id, message.to, message.from)
        return this.reply(message)
      })
      .immediate()
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
