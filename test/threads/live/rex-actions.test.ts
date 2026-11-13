import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "senu-rex-actions-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

writeFileSync(
  join(dir, "rex"),
  `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.REX_TEST_LOG, JSON.stringify(args) + "\\n");
if (process.env.REX_TEST_FAIL && args.includes(process.env.REX_TEST_FAIL)) process.exit(1);
console.log(JSON.stringify(args.includes("run")
  ? { window_id: "window:new", block_ids: ["block:new"] }
  : { revision: 1 }));
`,
)
chmodSync(join(dir, "rex"), 0o755)

const modulePath = join(import.meta.dir, "../../../src/threads/live/rex.ts")
async function invoke(expression: string, fail = "") {
  const log = join(dir, `${crypto.randomUUID()}.jsonl`)
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { rexJump, rexOpenWindow } from ${JSON.stringify(modulePath)}; console.log(await (${expression}));`,
    ],
    {
      env: {
        ...process.env,
        TMUX: "",
        REX_SESSION: "session:here",
        REX_BIN_DIR: dir,
        REX_TEST_LOG: log,
        REX_TEST_FAIL: fail,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(err).toBe("")
  expect(code).toBe(0)
  return {
    out: out.trim(),
    calls: readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]),
  }
}

describe("Rex jump", () => {
  for (const session of ["session:here", "session:other"]) {
    test(`focuses the block and selects the tab in ${session}`, async () => {
      const result = await invoke(`rexJump("${session}/block:target", "window:target")`)
      expect(result.out).toBe("ok")
      expect(result.calls).toEqual([
        [
          "--autostart=false",
          "api",
          "call",
          "session.focus_block",
          JSON.stringify({ session_id: session, block_id: "block:target" }),
        ],
        [
          "--autostart=false",
          "do",
          "session.select",
          `session_id=${session}`,
          "window_id=window:target",
        ],
      ])
    })
  }

  test("reports failure when the app cannot select the destination", async () => {
    const result = await invoke(
      'rexJump("session:here/block:target", "window:target")',
      "session.select",
    )
    expect(result.out).toBe("unselected")
  })

  test("does not switch the app when the target block is gone", async () => {
    const result = await invoke(
      'rexJump("session:here/block:gone", "window:target")',
      "session.focus_block",
    )
    expect(result.out).toBe("gone")
    expect(result.calls).toHaveLength(1)
  })
})

describe("Rex resume", () => {
  const launch =
    'rexOpenWindow({argv:["codex","resume","thread"],cwd:"/code",env:{CODEX_HOME:"/profile"}})'
  test("selects the created tab in the app and focuses its block", async () => {
    const result = await invoke(launch)
    expect(result.out).toBe("true")
    expect(result.calls[0]).toEqual([
      "--autostart=false",
      "run",
      "--json",
      "--interactive",
      "-s",
      "session:here",
      "-c",
      "/code",
      "--",
      "env",
      "CODEX_HOME=/profile",
      "codex",
      "resume",
      "thread",
    ])
    expect(JSON.parse(result.calls[1]!.at(-1)!)).toEqual({
      session_id: "session:here",
      block_id: "block:new",
    })
    expect(result.calls[2]).toEqual([
      "--autostart=false",
      "do",
      "session.select",
      "session_id=session:here",
      "window_id=window:new",
    ])
  })

  test("succeeds when the app can't select the created tab, so a retry won't start a copy", async () => {
    const result = await invoke(launch, "session.select")
    expect(result.out).toBe("true")
    expect(result.calls).toHaveLength(3)
  })

  test("does not select a tab when creation fails", async () => {
    const result = await invoke(launch, "run")
    expect(result.out).toBe("false")
    expect(result.calls).toHaveLength(1)
  })
})
