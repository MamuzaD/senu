import { tmux } from "~/detect/panes.ts"

export async function copy(text: string): Promise<boolean> {
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["pbcopy"], {
      stdin: new Blob([text]),
      stdout: "ignore",
      stderr: "ignore",
    })
    return (await proc.exited) === 0
  }
  // -w also sends it to the outer terminal's clipboard when tmux's set-clipboard allows
  return !!process.env.TMUX && (await tmux("set-buffer", "-w", "--", text)).ok
}
