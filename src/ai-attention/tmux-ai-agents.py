#!/usr/bin/env python3
"""tmux-ai-agents — cross-session agent picker (tmux popup TUI).

Lists every AI-agent window across ALL tmux sessions with its live status dot,
sorted by how much it wants you (blocked > done > working > idle), and lets you
jump straight to one. On macOS, if the agent's session is showing in another
Ghostty tab, jumping raises that tab (via Ghostty's AppleScript dictionary)
instead of pulling the session into your current tab. Meant to be opened in a
popup, e.g. bound to prefix+a:

    bind-key a display-popup -w 50% -h 60% -E "~/.local/bin/tmux-ai-agents"

State comes from the per-window @ai_state option maintained by tmux-ai-watch
(so the dots match your tab dots exactly). If the daemon isn't running, the
picker classifies panes live via the shared tmux-ai-detect engine.

Keys:  j/k or ↑/↓ move · ⏎ jump to agent · x/d kill (confirm) · r refresh · q/esc quit

See tmux/ai-attention/docs/ai-attention-standalone.md.
"""

import os
import re
import curses
import shutil
import subprocess
import importlib.machinery
import importlib.util


# --- shared detection engine (tmux-ai-detect sits next to us) ----------------

def _load_detect():
    here = os.path.dirname(os.path.realpath(__file__))
    path = os.path.join(here, "tmux-ai-detect.py")
    loader = importlib.machinery.SourceFileLoader("tmux_ai_detect", path)
    spec = importlib.util.spec_from_loader("tmux_ai_detect", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


D = _load_detect()


# --- model -------------------------------------------------------------------

# attention priority: what wants you most sorts to the top: "needs a decision"
# (blocked) > "still running"
# (working) > "ready to review" (done) > idle. ties break on recency below.
PRIORITY = {"blocked": 3, "working": 2, "done": 1, "idle": 0, "": -1}

# per-state glyph + curses color-pair id (pairs initialised in _init_colors)
DOT = {"blocked": "●", "working": "●", "done": "●", "idle": "◯", "": "·"}
PAIR = {"blocked": 1, "working": 2, "done": 3, "idle": 4}
DIM, NAME, SEL = 5, 6, 7

_PANE_FMT = ("#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t"
             "#{pane_id}\t#{pane_current_command}\t#{pane_title}\t"
             "#{window_activity}\t#{@ai_state}")


def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True,
                          text=True, check=False).stdout


# agents advertise their current task in the OSC title (Claude: "✳ <task>").
# strip the status glyph so we show the task text itself.
_TITLE_JUNK = "✳✻●○◯⏵➤➜»›* "


def _label(title, session, wname, widx):
    t = (title or "").strip().lstrip(_TITLE_JUNK).strip()
    # codex/plain shells title the pane with the dir (== session) — not useful
    if not t or t == session:
        return wname or widx
    return t


# codex puts no task in its OSC title, so we read the screen: the last user
# message is the last `› …` prompt that's followed by an agent turn (a `•`
# bullet / `─` separator). that skips the empty input box + its greyed hints
# ("Summarize recent commits") whether codex is idle or busy.
_CODEX_PROMPT = re.compile(r"^›\s+(\S.*?)\s*$")
_CODEX_STATUS = re.compile(r"Context \d+% (?:left|used)")


def _codex_task(capture):
    lines = capture.split("\n")
    prompts = [(i, m.group(1)) for i, ln in enumerate(lines)
               if (m := _CODEX_PROMPT.match(ln))]
    for idx, text in reversed(prompts):
        after = lines[idx + 1:]
        if any(a.startswith(("•", "─")) or a.lstrip().startswith("└")
               for a in after):
            return text
    # fallback: the branch shown in the status line (4th ` · `-separated field)
    for ln in reversed(lines):
        if _CODEX_STATUS.search(ln):
            fields = [f.strip() for f in ln.split("·")]
            if len(fields) > 3 and fields[3]:
                return fields[3]
            break
    return None


def collect():
    """One row per agent window across all sessions."""
    out = tmux("list-panes", "-a", "-F", _PANE_FMT)
    windows = {}   # window_id -> row
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 9:
            continue
        sess, wid, widx, wname, pid, cmd, title, activity, state = parts[:9]

        if not D.is_agent_candidate(cmd, title):
            continue
        # capture only when the command name alone can't identify the agent
        capture = "" if cmd in ("claude", "codex") else D.capture_pane(pid)
        agent = D.detect_agent(cmd, title, capture)
        if not agent:
            continue

        # codex has no task in its title -> read the screen for the label
        if agent == "codex" and not capture:
            capture = D.capture_pane(pid, lines=200)

        if not state:   # daemon not running / not yet classified -> live classify
            if not capture:
                capture = D.capture_pane(pid)
            state, _skip, _rule = D.classify_text(agent, title, capture)
            if state in (None, "unknown"):
                state = "idle"

        if agent == "codex":
            label = _codex_task(capture) or _label(title, sess, wname, widx)
        else:
            label = _label(title, sess, wname, widx)

        try:
            act = int(activity)
        except ValueError:
            act = 0

        cand = {
            "session": sess, "window_id": wid, "window_index": widx,
            "window_name": wname, "agent": agent, "state": state,
            "activity": act, "label": label, "pane_id": pid,
        }
        row = windows.get(wid)
        # keep the highest-priority pane's row per window; carry newest activity
        if row is None or PRIORITY.get(state, 0) > PRIORITY.get(row["state"], 0):
            if row is not None:
                cand["activity"] = max(cand["activity"], row["activity"])
            windows[wid] = cand
        else:
            row["activity"] = max(row["activity"], act)

    rows = list(windows.values())
    # rank: attention priority first, then most-recent activity
    rows.sort(key=lambda r: (-PRIORITY.get(r["state"], 0), -r["activity"]))
    return rows


def _session_attached(session):
    """True if the session is currently attached to a client (shown in a tab)."""
    return session in tmux("list-clients", "-F", "#{session_name}").split()


def _is_ghostty():
    return "ghostty" in tmux("display-message", "-p", "#{client_termname}").lower()


def _ghostty_focus_tab(session):
    """macOS only: raise the Ghostty tab whose title contains the session name.
    Ghostty sets each tab's title from the tmux session, so a substring match
    lands the right tab. Returns True on success; degrades to False when
    osascript/Ghostty/AppleScript isn't available (older Ghostty, no Automation
    permission, non-Ghostty terminal) so the caller can fall back."""
    if not _is_ghostty() or not shutil.which("osascript"):
        return False
    safe = session.replace("\\", "\\\\").replace('"', '\\"')
    script = ('tell application "Ghostty"\n'
              '  activate\n'
              '  select tab (first tab of front window whose name contains "%s")\n'
              'end tell' % safe)
    return subprocess.run(["osascript", "-e", script], capture_output=True,
                          text=True, check=False).returncode == 0


def jump(row):
    session = row["session"]
    # If the agent's session is already displayed in a (possibly different)
    # Ghostty tab, raise that tab and just point it at the agent's window —
    # don't switch-client, which would instead pull the session into the tab
    # you're currently in. Fall back to switch-client for detached sessions or
    # when Ghostty AppleScript isn't available.
    if _session_attached(session) and _ghostty_focus_tab(session):
        tmux("select-window", "-t", row["window_id"])
    else:
        tmux("switch-client", "-t", session)
        tmux("select-window", "-t", row["window_id"])


def kill(row):
    """Kill the agent's pane; tmux drops the window if it was the last pane."""
    pane = row.get("pane_id")
    if pane:
        tmux("kill-pane", "-t", pane)
    else:
        tmux("kill-window", "-t", row["window_id"])


# --- rendering ---------------------------------------------------------------

def _init_colors():
    curses.start_color()
    curses.use_default_colors()
    # match tmux.conf: blocked amber, working gold, done blue, idle green
    curses.init_pair(PAIR["blocked"], 215, -1)
    curses.init_pair(PAIR["working"], 179, -1)
    curses.init_pair(PAIR["done"], 111, -1)
    curses.init_pair(PAIR["idle"], 150, -1)
    curses.init_pair(DIM, 244, -1)
    curses.init_pair(NAME, 253, -1)
    curses.init_pair(SEL, 253, 237)     # selected-row background


def _addstr(win, y, x, text, attr):
    h, w = win.getmaxyx()
    if 0 <= y < h and x < w:
        try:
            win.addstr(y, x, text[: max(0, w - x - 1)], attr)
        except curses.error:
            pass


def draw(win, rows, sel, top):
    win.erase()
    h, w = win.getmaxyx()

    # header
    _addstr(win, 0, 2, "agents", curses.color_pair(DIM) | curses.A_BOLD)
    _addstr(win, 0, max(2, w - len("priority") - 2), "priority",
            curses.color_pair(DIM))

    if not rows:
        _addstr(win, 2, 2, "no agents running", curses.color_pair(DIM))
        _addstr(win, h - 1, 2, "r refresh · q quit", curses.color_pair(DIM))
        win.noutrefresh()
        return

    per = 2                      # two content lines + a gap per entry
    body_h = h - 3               # rows 2..h-2 reserved (h-1 is the help line)
    visible = max(1, body_h // per)

    for i in range(top, min(len(rows), top + visible)):
        r = rows[i]
        y = 2 + (i - top) * per
        selected = i == sel
        line_attr = curses.color_pair(SEL) if selected else 0

        if selected:                       # paint both lines' background
            _addstr(win, y, 0, " " * (w - 1), line_attr)
            _addstr(win, y + 1, 0, " " * (w - 1), line_attr)

        state = r["state"]
        dot_attr = curses.color_pair(PAIR.get(state, DIM))
        if state != "idle":
            dot_attr |= curses.A_BOLD

        # line 1:  ● session · task
        _addstr(win, y, 2, DOT.get(state, "·"), dot_attr)
        x = 4
        name_attr = (curses.color_pair(SEL) | curses.A_BOLD) if selected \
            else (curses.color_pair(NAME) | curses.A_BOLD)
        _addstr(win, y, x, r["session"], name_attr)
        x += len(r["session"])
        sep_attr = curses.color_pair(SEL) if selected else curses.color_pair(DIM)
        _addstr(win, y, x, " · ", sep_attr)
        x += 3
        _addstr(win, y, x, r["label"], sep_attr)

        # line 2:  agent name, indented under the session
        _addstr(win, y + 1, 4, r["agent"], sep_attr)

    # scroll hint + help
    more = ""
    if top > 0:
        more += "↑more "
    if top + visible < len(rows):
        more += "↓more"
    help_txt = "j/k move · ⏎ jump · x kill · r refresh · q quit"
    _addstr(win, h - 1, 2, help_txt, curses.color_pair(DIM))
    if more:
        _addstr(win, h - 1, max(2, w - len(more) - 2), more.strip(),
                curses.color_pair(DIM))
    win.noutrefresh()


def _confirm(stdscr, msg):
    """Blocking confirm modal centered over the screen. Returns True to proceed."""
    h, w = stdscr.getmaxyx()
    hint = "x / y = kill    ·    n / esc = cancel"
    bw = min(max(len(msg), len(hint)) + 4, max(12, w - 2))
    bh = 5
    win = curses.newwin(bh, bw, max(0, (h - bh) // 2), max(0, (w - bw) // 2))
    win.keypad(True)
    win.timeout(-1)              # block for a keypress (ignore the 1s auto-refresh)
    win.erase()
    try:
        border = curses.color_pair(PAIR["blocked"]) | curses.A_BOLD
        win.attron(border)
        win.border()
        win.attroff(border)
    except curses.error:
        pass
    _addstr(win, 1, 2, msg, curses.A_BOLD)
    _addstr(win, 3, 2, hint, curses.color_pair(DIM))
    win.noutrefresh()
    curses.doupdate()
    while True:
        ch = win.getch()
        if ch in (ord("y"), ord("Y"), ord("x"), ord("d"), curses.KEY_ENTER, 10, 13):
            return True
        if ch in (ord("n"), ord("N"), ord("q"), 27):
            return False


def _run(stdscr):
    curses.curs_set(0)
    _init_colors()
    stdscr.timeout(1000)          # 1s auto-refresh
    stdscr.keypad(True)

    rows = collect()
    sel, top = 0, 0

    while True:
        h, _w = stdscr.getmaxyx()
        per = 2
        visible = max(1, (h - 3) // per)

        if rows:
            sel = max(0, min(sel, len(rows) - 1))
            if sel < top:
                top = sel
            elif sel >= top + visible:
                top = sel - visible + 1

        draw(stdscr, rows, sel, top)
        curses.doupdate()

        try:
            ch = stdscr.getch()
        except KeyboardInterrupt:
            return

        if ch == -1:                                   # timeout -> refresh
            rows = collect()
            continue
        if ch in (ord("q"), 27):                       # q / esc
            return
        if ch in (ord("j"), curses.KEY_DOWN):
            sel += 1
        elif ch in (ord("k"), curses.KEY_UP):
            sel -= 1
        elif ch in (ord("g"), curses.KEY_HOME):
            sel = 0
        elif ch in (ord("G"), curses.KEY_END):
            sel = len(rows) - 1
        elif ch in (ord("r"),):
            rows = collect()
        elif ch in (ord("x"), ord("d")):
            if rows:
                r = rows[sel]
                lbl = (r["label"] or r["window_name"] or "")[:32]
                msg = "Kill %s — %s · %s?" % (r["agent"], r["session"], lbl)
                if _confirm(stdscr, msg):
                    kill(r)
                    rows = collect()
                stdscr.touchwin()          # clear the modal, force full redraw
        elif ch in (curses.KEY_ENTER, 10, 13):
            if rows:
                jump(rows[sel])
                return
        elif ch == curses.KEY_RESIZE:
            pass


def main():
    if subprocess.run(["tmux", "info"], capture_output=True,
                      check=False).returncode != 0:
        print("no tmux server")
        return 1
    try:
        curses.wrapper(_run)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
