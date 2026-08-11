#!/usr/bin/env bun
/**
 * tmux-ai-watch — self-contained polling daemon for per-window AI status + sound.
 *
 * Polls every tmux pane ~once/second, classifies agent panes with tmux-ai-detect,
 * folds pane states up to a per-window @ai_state option, and plays a sound on a
 * background window's transition.
 *
 * States written to @ai_state (window-status-format renders them):
 *   working  — agent busy                          (yellow ●)
 *   blocked  — agent needs you (permission/input)  (amber !)
 *   done     — finished while you weren't looking   (blue ●) — sticky until you
 *              focus the window, then it clears to idle
 *   idle     — waiting, and you've seen it          (green ●)
 *
 * Sounds (background window only, or any window if @ai_sound_always on):
 *   done    — on working -> idle
 *   request — on entering blocked
 *
 * Start from tmux.conf:  run-shell -b "~/.local/bin/tmux-ai-watch"
 * Single-instance guarded, so re-running on config reload is a no-op.
 *
 *   tmux-ai-watch          # daemon loop
 *   tmux-ai-watch once     # single poll, print transitions (debug)
 *   tmux-ai-watch test     # play request then done (verify audio path)
 *
 * See tmux/ai-attention/docs/ai-attention-standalone.md.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import * as D from "./tmux-ai-detect.ts";
import type { State } from "./tmux-ai-detect.ts";

const POLL_MS = 1000;
const RANK: Record<string, number> = { blocked: 3, working: 2, idle: 1 };
const SYS_SOUND: Record<string, string> = {
  done: "/System/Library/Sounds/Glass.aiff",
  request: "/System/Library/Sounds/Funk.aiff",
};

function pkgDir(): string {
  try {
    return dirname(realpathSync(import.meta.filename));
  } catch {
    return import.meta.dirname;
  }
}

// --- tmux plumbing ---

function tmux(...args: string[]): string {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return r.stdout ?? "";
}

function tmuxOk(): boolean {
  return spawnSync("tmux", ["info"]).status === 0;
}

function getGlobalOption(name: string): string {
  return tmux("show-option", "-gqv", name).trim();
}

const PANE_FMT =
  "#{pane_id}\t#{window_id}\t#{pane_current_command}\t#{window_active}\t#{session_attached}\t#{pane_title}";

export interface Pane {
  id: string;
  window: string;
  cmd: string;
  active: boolean;
  attached: boolean;
  title: string;
}

function listPanes(): Pane[] {
  const out = tmux("list-panes", "-a", "-F", PANE_FMT);
  const panes: Pane[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const p = line.split("\t");
    if (p.length < 6) continue;
    panes.push({
      id: p[0],
      window: p[1],
      cmd: p[2],
      active: p[3] === "1",
      attached: (p[4] || "0") !== "0",
      title: p.slice(5).join("\t"),
    });
  }
  return panes;
}

// --- sounds ---

function soundsDir(): string {
  return join(pkgDir(), "sounds");
}

function soundPath(kind: string): string | null {
  const opt = getGlobalOption(`@ai_sound_${kind}`);
  if (opt) {
    const p = opt.startsWith("~") ? homedir() + opt.slice(1) : opt;
    if (existsSync(p)) return p;
  }
  for (const ext of ["aiff", "wav", "mp3", "m4a"]) {
    const f = join(soundsDir(), `${kind}.${ext}`);
    if (existsSync(f)) return f;
  }
  return SYS_SOUND[kind] ?? null;
}

function play(kind: string): void {
  const p = soundPath(kind);
  if (!p || !existsSync(p)) return;
  try {
    spawn("afplay", [p], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* afplay unavailable (non-macOS) */
  }
}

// --- injectable side-effects (real impl + fakes in tests) ---

export interface Deps {
  listPanes(): Pane[];
  capturePane(id: string): string;
  detectAgent(cmd: string, title: string, cap: string): string | null;
  isAgentCandidate(cmd: string, title: string): boolean;
  classify(agent: string, title: string, cap: string, prev: State | null): State;
  setState(wid: string, value: string): void; // value "" -> unset
  refresh(): void;
  play(kind: string): void;
  soundAlways(): boolean;
}

function realDeps(): Deps {
  return {
    listPanes,
    capturePane: D.capturePane,
    detectAgent: D.detectAgent,
    isAgentCandidate: D.isAgentCandidate,
    classify: (a, t, c, p) => D.classifyText(a, t, c, p).state,
    setState: (wid, value) =>
      value ? tmux("set-option", "-w", "-t", wid, "@ai_state", value) : tmux("set-option", "-uw", "-t", wid, "@ai_state"),
    refresh: () => tmux("refresh-client", "-S"),
    play,
    soundAlways: () => ["1", "on", "true", "yes"].includes(getGlobalOption("@ai_sound_always")),
  };
}

// --- classification with per-pane throttle ---

function sig(title: string, capture: string): string {
  const ne = capture.split("\n").filter((l) => l.trim() !== "");
  return title + "\x00" + (ne.length ? ne[ne.length - 1] : "");
}

interface WinInfo {
  states: State[];
  fg: boolean;
}

export class Watcher {
  deps: Deps;
  paneState = new Map<string, { sig: string; state: State }>();
  winRaw = new Map<string, string>(); // last folded raw state (working/blocked/idle)
  winDisplayed = new Map<string, string>(); // what's written to @ai_state
  doneFlag = new Map<string, boolean>(); // finished-but-unseen sticky flag

  constructor(deps: Deps) {
    this.deps = deps;
  }

  poll(dry = false): void {
    const panes = this.deps.listPanes();
    const windows = new Map<string, WinInfo>();

    for (const p of panes) {
      if (!this.deps.isAgentCandidate(p.cmd, p.title)) continue;
      const capture = this.deps.capturePane(p.id);
      const agent = this.deps.detectAgent(p.cmd, p.title, capture);
      if (!agent) continue;

      const s = sig(p.title, capture);
      const prev = this.paneState.get(p.id);
      let state: State;
      if (prev && prev.sig === s) {
        state = prev.state; // unchanged screen -> reuse
      } else {
        state = this.deps.classify(agent, p.title, capture, prev ? prev.state : null);
        this.paneState.set(p.id, { sig: s, state });
      }

      let w = windows.get(p.window);
      if (!w) {
        w = { states: [], fg: false };
        windows.set(p.window, w);
      }
      w.states.push(state);
      if (p.active && p.attached) w.fg = true;
    }

    // drop bookkeeping for panes that vanished
    const live = new Set(panes.map((p) => p.id));
    for (const id of [...this.paneState.keys()]) if (!live.has(id)) this.paneState.delete(id);

    this.apply(windows, dry);
  }

  fold(states: State[]): string {
    let best = "";
    let rank = 0;
    for (const s of states) {
      const r = RANK[s] ?? 0;
      if (r > rank) {
        rank = r;
        best = s;
      }
    }
    return best;
  }

  apply(windows: Map<string, WinInfo>, dry: boolean): void {
    let changed = false;
    const seen = new Set<string>();
    const always = this.deps.soundAlways();

    for (const [wid, info] of windows) {
      seen.add(wid);
      const raw = this.fold(info.states);
      const oldRaw = this.winRaw.get(wid) ?? "";
      const fg = info.fg;

      // --- sticky "done" (finished but unseen) ---
      if (raw === "working" || raw === "blocked") {
        this.doneFlag.set(wid, false); // new activity clears a pending done
      } else if (raw === "idle" && oldRaw === "working") {
        if (!fg) this.doneFlag.set(wid, true); // finished off-screen -> blue dot
        if (always || !fg) this.emitSound("done", wid, oldRaw, raw, dry);
      }
      if (fg && this.doneFlag.get(wid)) this.doneFlag.set(wid, false); // you looked -> clear

      // --- request sound on entering blocked ---
      if (raw === "blocked" && oldRaw !== "blocked" && (always || !fg)) {
        this.emitSound("request", wid, oldRaw, raw, dry);
      }

      // --- displayed state ---
      let displayed: string;
      if (raw === "blocked") displayed = "blocked";
      else if (raw === "working") displayed = "working";
      else if (this.doneFlag.get(wid)) displayed = "done";
      else displayed = raw === "idle" ? "idle" : "";

      const oldDisplayed = this.winDisplayed.get(wid) ?? "";
      if (displayed !== oldDisplayed) {
        if (!dry) this.deps.setState(wid, displayed);
        changed = true;
      }

      this.winRaw.set(wid, raw);
      this.winDisplayed.set(wid, displayed);
    }

    // windows that lost all agent panes -> clear
    for (const wid of [...this.winDisplayed.keys()]) {
      if (!seen.has(wid)) {
        if (this.winDisplayed.get(wid)) {
          if (!dry) this.deps.setState(wid, "");
          changed = true;
        }
        this.winDisplayed.delete(wid);
        this.winRaw.delete(wid);
        this.doneFlag.delete(wid);
      }
    }

    if (changed && !dry) this.deps.refresh();
  }

  emitSound(kind: string, wid: string, old: string, next: string, dry: boolean): void {
    if (dry) console.log(`[sound] ${kind}  window=${wid}  ${old || "-"} -> ${next}`);
    else this.deps.play(kind);
  }
}

// --- single-instance lock (pidfile + liveness check) ---

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(): boolean {
  const p = join(tmpdir(), "tmux-ai-watch.lock");
  try {
    const pid = parseInt(readFileSync(p, "utf8").trim(), 10);
    if (pid && isAlive(pid)) return false;
  } catch {
    /* no lock file yet */
  }
  try {
    writeFileSync(p, String(process.pid));
  } catch {
    /* best effort */
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "once") {
    if (!tmuxOk()) {
      console.error("no tmux server");
      return 1;
    }
    new Watcher(realDeps()).poll(true);
    return 0;
  }

  if (argv[0] === "test") {
    for (const kind of ["request", "done"]) {
      console.log(`${kind.padEnd(8)} -> ${soundPath(kind)}`);
      play(kind);
      await sleep(1200);
    }
    return 0;
  }

  if (!acquireLock()) return 0; // another instance already running

  const w = new Watcher(realDeps());
  while (true) {
    try {
      if (tmuxOk()) w.poll();
    } catch {
      /* never let one bad poll kill the daemon */
    }
    await sleep(POLL_MS);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
