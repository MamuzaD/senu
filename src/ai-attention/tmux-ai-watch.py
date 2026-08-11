#!/usr/bin/env python3
"""tmux-ai-watch — self-contained polling daemon for per-window AI status + sound.

Polls every tmux pane ~once/second, classifies agent panes with the vendored
herdr manifests (via tmux-ai-detect), folds pane states up to a per-window
@ai_state option, and plays a sound on a background window's transition.

States written to @ai_state (window-status-format renders them):
    working  — agent busy                          (yellow  ●)
    blocked  — agent needs you (permission/input)  (amber   !)
    done     — finished while you weren't looking   (blue    ●) — sticky until you
               focus the window, then it clears to idle
    idle     — waiting, and you've seen it          (green   ◯)

Sounds (background window only, or any window if @ai_sound_always on):
    done    — on working -> idle
    request — on entering blocked

Start it from tmux.conf:   run-shell -b "~/.local/bin/tmux-ai-watch"
It is single-instance guarded, so re-running on config reload is a no-op.

    tmux-ai-watch            # daemon loop
    tmux-ai-watch once       # single poll, print what it would do (debug)
    tmux-ai-watch test       # play request then done (verify audio path)

Sounds are resolved from, in order:
    * tmux options  @ai_sound_done / @ai_sound_request  (a file path)
    * tmux/ai-attention/sounds/{done,request}.{aiff,wav,mp3,m4a}
    * macOS system sounds (Glass / Funk)
See tmux/ai-attention/docs/ai-attention-standalone.md.
"""

import os
import sys
import time
import fcntl
import random
import hashlib
import tempfile
import subprocess
import importlib.machinery
import importlib.util

POLL_SECONDS = 1.0
STATE_RANK = {"blocked": 3, "working": 2, "idle": 1}
SYS_SOUND = {"done": "/System/Library/Sounds/Glass.aiff",
             "request": "/System/Library/Sounds/Funk.aiff"}


# --- load the shared engine (tmux-ai-detect sits next to us in the repo) -----

def _load_detect():
    here = os.path.dirname(os.path.realpath(__file__))
    path = os.path.join(here, "tmux-ai-detect.py")
    loader = importlib.machinery.SourceFileLoader("tmux_ai_detect", path)
    spec = importlib.util.spec_from_loader("tmux_ai_detect", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


D = _load_detect()


# --- tmux plumbing -----------------------------------------------------------

def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True,
                          text=True, check=False).stdout


def tmux_ok():
    return subprocess.run(["tmux", "info"], capture_output=True,
                          check=False).returncode == 0


_PANE_FMT = ("#{pane_id}\t#{window_id}\t#{pane_current_command}\t"
             "#{window_active}\t#{session_attached}\t#{pane_title}")


def list_panes():
    out = tmux("list-panes", "-a", "-F", _PANE_FMT)
    panes = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        pid, wid, cmd, active, attached, title = parts[:6]
        panes.append({
            "id": pid, "window": wid, "cmd": cmd,
            "active": active == "1",
            "attached": (attached or "0") != "0",
            "title": title,
        })
    return panes


def get_global_option(name):
    return tmux("show-option", "-gqv", name).strip()


# --- sounds ------------------------------------------------------------------

def _sounds_dir():
    return os.path.join(os.path.dirname(os.path.realpath(__file__)), "sounds")


def sound_path(kind):
    opt = get_global_option(f"@ai_sound_{kind}")
    if opt:
        opt = os.path.expanduser(opt)
        if os.path.exists(opt):
            return opt
    # dynamic pool: sounds/<kind>/*.{aiff,wav,mp3,m4a} -> random pick each time
    # (drop any number of clips/voice-lines in here; they rotate)
    pool = os.path.join(_sounds_dir(), kind)
    if os.path.isdir(pool):
        cand = [os.path.join(pool, f) for f in os.listdir(pool)
                if f.lower().endswith((".aiff", ".wav", ".mp3", ".m4a"))]
        if cand:
            return random.choice(cand)
    # single fallback file
    for ext in ("aiff", "wav", "mp3", "m4a"):
        f = os.path.join(_sounds_dir(), f"{kind}.{ext}")
        if os.path.exists(f):
            return f
    return SYS_SOUND.get(kind)


def play(kind):
    path = sound_path(kind)
    if not path or not os.path.exists(path):
        return
    try:
        subprocess.Popen(["afplay", path],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        pass


# --- classification with per-pane throttle -----------------------------------

def _sig(title, capture):
    nonempty = [l for l in capture.split("\n") if l.strip()]
    tail = nonempty[-1] if nonempty else ""
    h = hashlib.blake2b((title + "\x00" + tail).encode("utf-8", "replace"),
                        digest_size=8).hexdigest()
    return h


class Watcher:
    def __init__(self):
        self.pane_state = {}       # pane_id -> {"sig": h, "state": s}
        self.win_raw = {}          # window_id -> last folded raw state
        self.win_displayed = {}    # window_id -> value written to @ai_state
        self.done_flag = {}        # window_id -> finished-but-unseen sticky flag
        self.seen_windows = set()  # windows observed at least once (first-poll guard)

    def poll(self, dry=False):
        panes = list_panes()
        windows = {}            # window_id -> {"states": [...], "fg": bool}

        for p in panes:
            if not D.is_agent_candidate(p["cmd"], p["title"]):
                continue
            capture = D.capture_pane(p["id"])
            agent = D.detect_agent(p["cmd"], p["title"], capture)
            if not agent:
                continue

            sig = _sig(p["title"], capture)
            prev = self.pane_state.get(p["id"])
            if prev and prev["sig"] == sig:
                state = prev["state"]           # unchanged screen -> reuse
            else:
                state, _skip, _rule = D.classify_text(
                    agent, p["title"], capture,
                    prev_state=prev["state"] if prev else None)
                self.pane_state[p["id"]] = {"sig": sig, "state": state}

            w = windows.setdefault(p["window"], {"states": [], "fg": False})
            w["states"].append(state)
            if p["active"] and p["attached"]:
                w["fg"] = True

        # drop bookkeeping for panes that vanished
        live = {p["id"] for p in panes}
        for dead in [pid for pid in self.pane_state if pid not in live]:
            del self.pane_state[dead]

        self._apply(windows, dry)

    def _fold(self, states):
        best, rank = "", 0
        for s in states:
            r = STATE_RANK.get(s, 0)
            if r > rank:
                rank, best = r, s
        return best

    def _apply(self, windows, dry):
        changed = False
        seen = set()
        # @ai_sound_always on  -> chime even for the foreground window (useful
        # for testing, or if you keep the agent tab focused but look elsewhere)
        always = get_global_option("@ai_sound_always") in ("1", "on", "true", "yes")

        for wid, info in windows.items():
            seen.add(wid)
            raw = self._fold(info["states"])
            old_raw = self.win_raw.get(wid, "")
            fg = info["fg"]
            first = wid not in self.seen_windows   # daemon's first sight of this window
            self.seen_windows.add(wid)

            # --- sticky "done" (finished but unseen) ---
            if raw in ("working", "blocked"):
                self.done_flag[wid] = False        # new activity clears a pending done
            elif raw == "idle" and old_raw == "working":
                if not fg:
                    self.done_flag[wid] = True      # finished off-screen -> blue dot
                if always or not fg:
                    self._sound("done", wid, old_raw, raw, dry)
            if fg and self.done_flag.get(wid):
                self.done_flag[wid] = False         # you looked -> clear

            # --- request sound on entering blocked (not on the daemon's first sight) ---
            if raw == "blocked" and old_raw != "blocked" and not first \
                    and (always or not fg):
                self._sound("request", wid, old_raw, raw, dry)

            # --- displayed state ---
            if raw == "blocked":
                displayed = "blocked"
            elif raw == "working":
                displayed = "working"
            elif self.done_flag.get(wid):
                displayed = "done"
            else:
                displayed = "idle" if raw == "idle" else ""

            old_displayed = self.win_displayed.get(wid, "")
            if displayed != old_displayed:
                if not dry:
                    if displayed:
                        tmux("set-option", "-w", "-t", wid, "@ai_state", displayed)
                    else:
                        tmux("set-option", "-uw", "-t", wid, "@ai_state")
                changed = True

            self.win_raw[wid] = raw
            self.win_displayed[wid] = displayed

        # windows that lost all agent panes -> clear
        for wid in [w for w in self.win_displayed if w not in seen]:
            if self.win_displayed[wid]:
                if not dry:
                    tmux("set-option", "-uw", "-t", wid, "@ai_state")
                changed = True
            del self.win_displayed[wid]
            self.win_raw.pop(wid, None)
            self.done_flag.pop(wid, None)
            self.seen_windows.discard(wid)

        if changed and not dry:
            tmux("refresh-client", "-S")

    def _sound(self, kind, wid, old, new, dry):
        if dry:
            print(f"[sound] {kind}  window={wid}  {old or '-'} -> {new}")
        else:
            play(kind)


# --- single-instance lock ----------------------------------------------------

def acquire_lock():
    path = os.path.join(tempfile.gettempdir(), "tmux-ai-watch.lock")
    fh = open(path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return None
    return fh   # keep referenced for the process lifetime


def main(argv):
    if argv[:1] == ["once"]:
        if not tmux_ok():
            print("no tmux server", file=sys.stderr)
            return 1
        Watcher().poll(dry=True)
        return 0

    if argv[:1] == ["test"]:
        # verify the audio path end-to-end (ignores foreground gating)
        for kind in ("request", "done"):
            path = sound_path(kind)
            print(f"{kind:8} -> {path}")
            play(kind)
            subprocess.run(["sleep", "1.2"], check=False)
        return 0

    lock = acquire_lock()
    if lock is None:
        return 0    # another instance already running

    w = Watcher()
    while True:
        try:
            if tmux_ok():
                w.poll()
        except Exception:
            pass    # never let one bad poll kill the daemon
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
