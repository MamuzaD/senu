import { expect, test } from "bun:test"

test("explicit tmux sockets override Rex detection, and clearing them restores Rex", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { setTmuxSocket } from "~/detect/panes.ts";
       import { mux } from "~/threads/live/mux.ts";
       import { rexMux } from "~/threads/live/rex.ts";
       import { tmuxMux } from "~/threads/live/tmux.ts";
       const selected = [mux() === rexMux];
       for (const args of [["-L", "test"], ["-S", "/tmp/test.sock"]]) {
         setTmuxSocket(args);
         selected.push(mux() === tmuxMux);
       }
       setTmuxSocket([]);
       selected.push(mux() === rexMux);
       console.log(JSON.stringify(selected));`,
    ],
    {
      cwd: new URL("../../../", import.meta.url).pathname,
      env: { ...process.env, TMUX: "", REX_SESSION: "session:test" },
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
  expect(JSON.parse(out)).toEqual([true, true, true, true])
})
