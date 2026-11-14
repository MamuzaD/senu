import { Database } from "bun:sqlite"
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs"
import { dirname, join } from "node:path"

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
    this.db
      .query(
        'INSERT INTO messages (message_id, "from", "to", text, reply_to, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, from, to, text, replyTo ?? null, "pending", Date.now())
    try {
      const delivery = await deliver(id)
      this.db.query("UPDATE messages SET status = 'delivered' WHERE message_id = ?").run(id)
      return { message_id: id, delivery }
    } catch (error) {
      this.db.query("UPDATE messages SET status = 'failed' WHERE message_id = ?").run(id)
      throw error
    }
  }

  reply(message: Message) {
    return this.db
      .query<Message, [string, string, string]>(
        `SELECT * FROM messages WHERE reply_to = ? AND "from" = ? AND "to" = ?
         AND status = 'delivered' ORDER BY rowid LIMIT 1`,
      )
      .get(message.message_id, message.to, message.from)
  }
}
