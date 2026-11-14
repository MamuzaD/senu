import { Database } from "bun:sqlite"
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

test("wait finds replies from another process and repeated waits return the same answer", async () => {
  const { root } = setup()
  const path = join(root, "messages.sqlite")
  const store = new MessageStore(path)
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const question = await store.send(from, to, "question", undefined, async () => "delivered")
    const waiting = store.waitForReply(question.message_id, from, profiles, 2_000)
    child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { MessageStore } = await import(process.argv[1]);
         const store = new MessageStore(process.argv[2]);
         try { await store.send(process.argv[3], process.argv[4], "cross-process answer", process.argv[5], async () => "delivered"); }
         finally { store.close(); }`,
        join(import.meta.dir, "../../src/mcp/store.ts"),
        path,
        to,
        from,
        question.message_id,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const result = await waiting
    expect(await child.exited).toBe(0)
    expect(result).toMatchObject({
      message_id: question.message_id,
      timed_out: false,
      reply: { from: to, text: "cross-process answer" },
    })
    expect(await store.waitForReply(question.message_id, from, profiles, 1)).toEqual(result)
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
      await child.exited
    }
    store.close()
  }
})

test("timeout preserves late replies; cancellation and access errors end waits", async () => {
  const { root } = setup()
  const store = new MessageStore(join(root, "messages.sqlite"))
  try {
    const question = await store.send(from, to, "question", undefined, async () => "delivered")
    const id = question.message_id
    expect(await store.waitForReply(id, from, profiles, 1)).toEqual({
      message_id: id,
      timed_out: true,
      reply: null,
    })
    const abort = new AbortController()
    const waiting = store.waitForReply(id, from, profiles, 60_000, abort.signal)
    abort.abort()
    await rejects(waiting, "abort")
    await rejects(store.waitForReply(id, to, profiles, 1), "Message not found")
    await rejects(store.waitForReply(id, from, ["codex-personal"], 1), "Message not found")
    await rejects(store.waitForReply(id, from, profiles, 60_001), "timeout_ms")
    await store.send(to, from, "late answer", id, async () => "delivered")
    expect((await store.waitForReply(id, from, profiles, 1)).reply?.text).toBe("late answer")
  } finally {
    store.close()
  }
})

test("a reply is delivered only when its sender is not waiting for it", async () => {
  const { root } = setup()
  const path = join(root, "messages.sqlite")
  const asker = new MessageStore(path)
  const peer = new MessageStore(path)
  const delivered: string[] = []
  const deliver = (text: string) => async () => {
    delivered.push(text)
    return "delivered"
  }
  try {
    const question = await asker.send(from, to, "question", undefined, async () => "delivered")
    const id = question.message_id
    const waiting = asker.waitForReply(id, from, profiles, 2_000)
    const held = await peer.send(to, from, "awaited answer", id, deliver("awaited answer"))
    expect(held.delivery).toBe("returned to the waiting sender")
    expect((await waiting).reply).toMatchObject({
      message_id: held.message_id,
      text: "awaited answer",
    })
    const later = await peer.send(to, from, "follow-up", id, deliver("follow-up"))
    expect(later.delivery).toBe("delivered")

    const second = await asker.send(from, to, "second", undefined, async () => "delivered")
    expect((await asker.waitForReply(second.message_id, from, profiles, 1)).timed_out).toBe(true)
    await peer.send(to, from, "after timeout", second.message_id, deliver("after timeout"))

    const third = await asker.send(from, to, "third", undefined, async () => "delivered")
    const abort = new AbortController()
    const cancelled = asker.waitForReply(third.message_id, from, profiles, 60_000, abort.signal)
    abort.abort()
    await rejects(cancelled, "abort")
    await peer.send(to, from, "after cancel", third.message_id, deliver("after cancel"))

    expect(delivered).toEqual(["follow-up", "after timeout", "after cancel"])
  } finally {
    asker.close()
    peer.close()
  }
})

test("a wait keeps returning its first reply after an earlier one is delivered late", async () => {
  const { root } = setup()
  const store = new MessageStore(join(root, "messages.sqlite"))
  try {
    const question = await store.send(from, to, "question", undefined, async () => "delivered")
    const id = question.message_id
    const slow = Promise.withResolvers<string>()
    const early = store.send(to, from, "sent first", id, () => slow.promise)
    await store.send(to, from, "delivered first", id, async () => "delivered")
    const first = await store.waitForReply(id, from, profiles, 1)
    expect(first.reply?.text).toBe("delivered first")
    slow.resolve("delivered")
    await early
    expect(await store.waitForReply(id, from, profiles, 1)).toEqual(first)
  } finally {
    store.close()
  }
})

test("sending drops messages older than a week, with their pinned replies", async () => {
  const { root } = setup()
  const path = join(root, "messages.sqlite")
  const store = new MessageStore(path)
  const db = new Database(path)
  const count = (table: string) =>
    db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n
  try {
    const old = await store.send(from, to, "old question", undefined, async () => "delivered")
    await store.send(to, from, "old answer", old.message_id, async () => "delivered")
    void store.send(from, to, "never delivered", undefined, () => new Promise(() => {}))
    expect((await store.waitForReply(old.message_id, from, profiles, 1)).reply?.text).toBe(
      "old answer",
    )
    expect([count("messages"), count("answers")]).toEqual([3, 1])
    const week = 7 * 24 * 60 * 60 * 1000
    db.run("UPDATE messages SET created_at = ?", [Date.now() - week + 60_000])
    const kept = await store.send(from, to, "inside the week", undefined, async () => "delivered")
    expect(count("messages")).toBe(4)
    db.run("UPDATE messages SET created_at = ? WHERE message_id != ?", [
      Date.now() - week - 1,
      kept.message_id,
    ])
    const fresh = await store.send(from, to, "fresh", undefined, async () => "delivered")
    expect([count("messages"), count("answers")]).toEqual([2, 0])
    expect(store.sent(fresh.message_id, from, profiles).text).toBe("fresh")
    expect(() => store.sent(old.message_id, from, profiles)).toThrow("Message not found")
    await rejects(
      store.send(to, from, "too late", old.message_id, async () => "delivered"),
      "Reply target not found",
    )
  } finally {
    db.close()
    store.close()
  }
})
