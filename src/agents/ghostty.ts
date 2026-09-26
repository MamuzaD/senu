/**
 * Raising the Ghostty tab a tmux session is showing in, through Ghostty's
 * AppleScript dictionary (Ghostty 1.3+: windows, their tabs, `select tab`,
 * `activate window`). tmux titles each client's terminal with
 * `set-titles-string`, `#S:#I:#W …` by default, so the tab whose name starts
 * with `<session>:` is that session's; failing that, any tab whose name
 * contains the session's name. The tab the picker was opened from is never
 * the answer.
 */

export const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

export function raiseTabScript(session: string): string {
  return `tell application "Ghostty"
  set wanted to ${appleString(session)}
  set here to missing value
  try
    set here to id of selected tab of front window
  end try
  repeat with pass from 1 to 2
    repeat with w in windows
      repeat with t in tabs of w
        set n to name of t
        if id of t is not here then
          if (pass is 1 and n starts with (wanted & ":")) or (pass is 2 and n contains wanted) then
            select tab t
            activate window w
            return "raised"
          end if
        end if
      end repeat
    end repeat
  end repeat
  return "none"
end tell`
}

/** Give up on Ghostty (no Automation permission yet, a hung app) after this long, and switch the client instead. */
const TIMEOUT_MS = 2000

/** Raise the session's tab. False when there's no such tab, or osascript or Ghostty's dictionary isn't there. */
export async function raiseGhosttyTab(session: string): Promise<boolean> {
  if (process.platform !== "darwin" || !Bun.which("osascript")) return false
  try {
    const proc = Bun.spawn(["osascript", "-e", raiseTabScript(session)], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS)
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return code === 0 && out.trim() === "raised"
  } catch {
    return false
  }
}
