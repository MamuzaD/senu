#!/usr/bin/env python3
"""tmux-ai-detect — standalone reimplementation of herdr's rule engine.

Classifies a tmux pane running an AI agent as working|idle|blocked|unknown by
running the vendored herdr TOML manifests (tmux/ai-attention/detection/{claude,codex}.toml)
against the pane's OSC title + captured screen. No herdr binary required.

Used as a library by tmux-ai-watch, and as a CLI for debugging:

    tmux-ai-detect classify <pane_id> [agent]
    tmux-ai-detect explain  <pane_id> [agent]   # dump regions + matched rule

See tmux/ai-attention/docs/ai-attention-standalone.md for the full design.
"""

import os
import re
import sys
import tomllib
import subprocess
from functools import lru_cache

# ---------------------------------------------------------------------------
# manifest location (resolve through the ~/.local/bin symlink to the repo)
# ---------------------------------------------------------------------------

def _pkg_dir():
    return os.path.dirname(os.path.realpath(__file__))


def _manifest_path(agent):
    # allow an XDG override, else fall back to the vendored copy next to us
    candidates = [
        os.path.expanduser(f"~/.config/tmux/ai-attention/detection/{agent}.toml"),
        os.path.join(_pkg_dir(), "detection", f"{agent}.toml"),
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


@lru_cache(maxsize=8)
def load_manifest(agent):
    path = _manifest_path(agent)
    if not path:
        return None
    with open(path, "rb") as fh:
        return tomllib.load(fh)


# ---------------------------------------------------------------------------
# Rust-regex -> python-regex translation + compilation
# ---------------------------------------------------------------------------

def _translate_rust_regex(pat):
    # \x{2800} -> \u2800 (or \U0001F600 for astral code points)
    def _hex(m):
        cp = int(m.group(1), 16)
        return "\\u%04X" % cp if cp <= 0xFFFF else "\\U%08X" % cp

    pat = re.sub(r"\\x\{([0-9A-Fa-f]+)\}", _hex, pat)
    # Rust end-of-text anchor is \z; python spells it \Z. \A is shared.
    pat = re.sub(r"(?<!\\)\\z", r"\\Z", pat)
    return pat


@lru_cache(maxsize=1024)
def _compile(pat):
    return re.compile(_translate_rust_regex(pat))


# ---------------------------------------------------------------------------
# condition matching (contains / regex / line_regex / any / all / not)
# ---------------------------------------------------------------------------

def _match_cond(cond, text):
    """A condition (or a rule) matches when every matcher key it carries holds.

    Non-matcher keys (id, state, priority, region, skip_state_update, visible_*)
    are ignored, so a whole rule dict can be passed straight in.
    """
    if "contains" in cond:
        for needle in cond["contains"]:
            if needle not in text:
                return False

    if "regex" in cond:
        if not any(_compile(p).search(text) for p in cond["regex"]):
            return False

    if "line_regex" in cond:
        lines = text.split("\n")
        hit = any(_compile(p).search(ln) for p in cond["line_regex"] for ln in lines)
        if not hit:
            return False

    if "any" in cond:
        if not any(_match_cond(sub, text) for sub in cond["any"]):
            return False

    if "all" in cond:
        if not all(_match_cond(sub, text) for sub in cond["all"]):
            return False

    if "not" in cond:
        if any(_match_cond(sub, text) for sub in cond["not"]):
            return False

    return True


# ---------------------------------------------------------------------------
# region resolution (manifest region name -> text)
# ---------------------------------------------------------------------------

_RULE_LINE = re.compile(r"^\s*[\u2500-\u257F\-]{3,}\s*$")   # box-drawing / --- rules
_PROMPT_MARK = re.compile(r"[\u276F\u2590\u203A]")            # ❯ ▐ ›
_PROMPT_GT = re.compile(r"^\s*>\s")
_BOX_TOP = re.compile(r"[\u256D\u250C]")                      # ╭ ┌
_BOX_BOT = re.compile(r"[\u2570\u2514]")                      # ╰ └


class Regions:
    """Lazily builds + caches region text from a pane's title and capture."""

    def __init__(self, title, capture):
        self.title = title or ""
        self.capture = capture or ""
        self._lines = self.capture.split("\n")
        self._nonempty = [l for l in self._lines if l.strip()]
        self._cache = {}

    def get(self, name):
        if name not in self._cache:
            self._cache[name] = self._build(name)
        return self._cache[name]

    def _build(self, name):
        m = re.match(r"^(\w+)\((\d+)\)$", name)
        if m:
            fn, n = m.group(1), int(m.group(2))
            if fn == "bottom_non_empty_lines":
                return "\n".join(self._nonempty[-n:])
            if fn == "top_non_empty_lines":
                return "\n".join(self._nonempty[:n])
            return ""

        if name == "osc_title":
            return self.title
        if name == "whole_recent":
            return self.capture
        if name == "osc_progress":
            return None  # not observable in tmux; rules using it never match
        if name == "after_last_horizontal_rule":
            idx = -1
            for i, l in enumerate(self._lines):
                if _RULE_LINE.match(l):
                    idx = i
            return "\n".join(self._lines[idx + 1:]) if idx >= 0 else ""
        if name == "after_last_prompt_marker":
            # approximation: text from the last prompt line onward (incl. footer)
            idx = -1
            for i, l in enumerate(self._lines):
                if _PROMPT_MARK.search(l) or _PROMPT_GT.match(l):
                    idx = i
            return "\n".join(self._lines[idx:]) if idx >= 0 else self.capture
        if name == "prompt_box_body":
            # approximation: content between the last box borders near the bottom
            top = bot = -1
            for i, l in enumerate(self._lines):
                if _BOX_TOP.search(l):
                    top = i
            for j in range(len(self._lines) - 1, -1, -1):
                if _BOX_BOT.search(self._lines[j]):
                    bot = j
                    break
            if 0 <= top < bot:
                return "\n".join(self._lines[top + 1:bot])
            return "\n".join(self._nonempty[-3:])
        return ""


# ---------------------------------------------------------------------------
# engine
# ---------------------------------------------------------------------------

def classify_text(agent, title, capture, prev_state=None):
    """Return (state, skip_state_update, rule_id)."""
    manifest = load_manifest(agent)
    if not manifest:
        return ("unknown", False, None)

    regions = Regions(title, capture)
    rules = sorted(manifest.get("rules", []),
                   key=lambda r: r.get("priority", 0), reverse=True)

    for rule in rules:
        text = regions.get(rule["region"])
        if text is None:            # unobservable region (osc_progress)
            continue
        if _match_cond(rule, text):
            if rule.get("skip_state_update"):
                return (prev_state, True, rule.get("id"))
            return (rule.get("state", "unknown"), False, rule.get("id"))

    return (prev_state if prev_state else "unknown", False, None)


# ---------------------------------------------------------------------------
# tmux helpers + agent detection (shared with tmux-ai-watch)
# ---------------------------------------------------------------------------

def _tmux(*args):
    try:
        return subprocess.run(["tmux", *args], capture_output=True,
                              text=True, check=False).stdout
    except FileNotFoundError:
        return ""


def capture_pane(pane_id, lines=80):
    return _tmux("capture-pane", "-p", "-t", pane_id, "-S", f"-{lines}")


def pane_title(pane_id):
    return _tmux("display-message", "-p", "-t", pane_id, "#{pane_title}").rstrip("\n")


_KNOWN_CMDS = {"claude": "claude", "codex": "codex"}
_VERSION_CMD = re.compile(r"^\d+\.\d+")          # claude often execs as "2.1.227"
_AGENT_TITLE = re.compile(r"[⠀-⣿]|✳|✻|Action Required")

# screen markers that identify an agent when the command name is ambiguous
_CLAUDE_MARKS = ("⏵⏵", "shift+tab to cycle", "auto-compact",
                 "? for shortcuts", "Bypassing Permissions", "✻",
                 "Claude Code")
_CODEX_MARKS = ("esc to interrupt", "Worked for", "⏎ send", "gpt-5",
                "Action Required", "codex")


def is_agent_candidate(command, title):
    """Cheap pre-filter (no capture): could this pane be an agent?"""
    return (command in ("claude", "codex", "node", "node.js", "bun", "deno")
            or bool(_VERSION_CMD.match(command or ""))
            or bool(_AGENT_TITLE.search(title or "")))


def detect_agent(command, title, capture):
    """Map a pane's foreground command (+ screen sniff) to an agent name."""
    if command == "codex":
        return "codex"
    if command == "claude":
        return "claude"
    blob = f"{title or ''}\n{capture or ''}"
    if any(m in blob for m in _CLAUDE_MARKS):
        return "claude"
    if any(m in blob for m in _CODEX_MARKS):
        return "codex"
    return None


# ---------------------------------------------------------------------------
# CLI (debug)
# ---------------------------------------------------------------------------

def _cli(argv):
    if len(argv) < 2 or argv[0] not in ("classify", "explain"):
        sys.stderr.write(
            "usage: tmux-ai-detect {classify|explain} <pane_id> [agent]\n")
        return 64

    cmd, pane = argv[0], argv[1]
    title = pane_title(pane)
    capture = capture_pane(pane)
    agent = argv[2] if len(argv) > 2 else detect_agent(
        _tmux("display-message", "-p", "-t", pane,
              "#{pane_current_command}").strip(), title, capture)

    if not agent:
        sys.stderr.write("could not identify agent for pane; pass one explicitly\n")
        return 1

    state, skip, rule = classify_text(agent, title, capture)

    if cmd == "classify":
        print(state)
        return 0

    # explain
    manifest = load_manifest(agent)
    regions = Regions(title, capture)
    print(f"agent : {agent}  (manifest {manifest.get('version','?')})")
    print(f"state : {state}   skip={skip}   rule={rule}")
    print(f"title : {title!r}")
    seen = []
    for r in manifest.get("rules", []):
        if r["region"] not in seen:
            seen.append(r["region"])
    for name in seen:
        text = regions.get(name)
        print(f"\n--- region {name} ---")
        print("<unavailable>" if text is None else text)
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
