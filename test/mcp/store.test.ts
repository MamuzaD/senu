import { afterEach, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { join } from "node:path"

import { MessageStore } from "~/mcp/store.ts"

import { cleanup, setup } from "../chats.ts"

afterEach(cleanup)

const from = "codex-personal:questioner"
const to = "claude-work:peer"
const profiles = ["codex-personal", "claude-work"]

async function rejects(promise: Promise<unknown>, text: string) {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain(text)
}

test("separate connections correlate delivered replies and reject other conversations", async () => {
  const { root } = setup()
  const path = join(root, "messages.sqlite")
  const a = new MessageStore(path)
  const b = new MessageStore(path)
  try {
    const question = await a.send(from, to, "question", undefined, async () => "queued in Codex")
    expect(question.delivery).toBe("queued in Codex")
    for (const file of [path, `${path}-wal`]) expect(statSync(file).mode & 0o777).toBe(0o600)
    const original = a.sent(question.message_id, from, profiles)
    await b.send(to, from, "unrelated", undefined, async () => "delivered")
    expect(a.reply(original)).toBeNull()
    await rejects(
      b.send(
        "claude-work:someone-else",
        from,
        "wrong peer",
        question.message_id,
        async () => "delivered",
      ),
      "Reply target not found",
    )
    await rejects(
      b.send(
        to,
        "codex-personal:other",
        "wrong recipient",
        question.message_id,
        async () => "delivered",
      ),
      "Reply target not found",
    )
    expect(() => b.sent(question.message_id, to, profiles)).toThrow("Message not found")
    expect(() => a.sent(question.message_id, from, ["codex-personal"])).toThrow("Message not found")
    const reply = await b.send(to, from, "answer", question.message_id, async () => "delivered")
    expect(a.reply(original)).toMatchObject({
      message_id: reply.message_id,
      from: to,
      to: from,
      text: "answer",
      reply_to: question.message_id,
      status: "delivered",
      created_at: expect.any(Number),
    })
  } finally {
    a.close()
    b.close()
  }
})

test("a fast reply can arrive before send returns, but failed deliveries never become replies", async () => {
  const { root } = setup()
  const store = new MessageStore(join(root, "messages.sqlite"))
  try {
    const question = await store.send(from, to, "question", undefined, async (id) => {
      await store.send(to, from, "fast answer", id, async () => "delivered")
      return "delivered"
    })
    expect(store.reply(store.sent(question.message_id, from, profiles))?.text).toBe("fast answer")
    const next = await store.send(from, to, "next", undefined, async () => "delivered")
    let failedId = ""
    await rejects(
      store.send(to, from, "lost answer", next.message_id, async (id) => {
        failedId = id
        expect(store.reply(store.sent(next.message_id, from, profiles))).toBeNull()
        throw new Error("transport failed")
      }),
      "transport failed",
    )
    expect(store.reply(store.sent(next.message_id, from, profiles))).toBeNull()
    expect(() => store.sent(failedId, to, profiles)).toThrow("Message delivery failed")
    await rejects(
      store.send(from, to, "reply to failure", failedId, async () => "delivered"),
      "Reply target not found",
    )
  } finally {
    store.close()
  }
})
