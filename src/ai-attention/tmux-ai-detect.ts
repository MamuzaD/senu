#!/usr/bin/env bun
/**
 * tmux-ai-detect — standalone reimplementation of herdr's rule engine (TypeScript).
 *
 * Given one pane's OSC title + screen capture, it runs the vendored herdr TOML
 * manifests (tmux/ai-attention/detection/{claude,codex}.toml) and returns
 * working | idle | blocked | unknown. No herdr binary required.
 *
 * Library for tmux-ai-watch, and a debug CLI (runs under bun or Node 22.6+):
 *   tmux-ai-detect classify <pane_id> [agent]
 *   tmux-ai-detect explain  <pane_id> [agent]   # dump regions + matched rule
 *
 * See tmux/ai-attention/docs/ai-attention-standalone.md for the full design.
 */
import { load } from "js-toml";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type State = "working" | "idle" | "blocked" | "unknown";

interface Cond {
  contains?: string[];
  regex?: string[];
  line_regex?: string[];
  any?: Cond[];
  all?: Cond[];
  not?: Cond[];
}
export interface Rule extends Cond {
  id: string;
  state: State;
  priority: number;
  region: string;
  skip_state_update?: boolean;
}
export interface Manifest {
  id: string;
  version?: string;
  rules: Rule[];
}

// --- manifest location (resolve through the ~/.local/bin symlink to the repo) ---

function pkgDir(): string {
  try {
    return dirname(realpathSync(import.meta.filename));
  } catch {
    return import.meta.dirname;
  }
}

function manifestPath(agent: string): string | null {
  const candidates = [
    join(homedir(), ".config/tmux/ai-attention/detection", `${agent}.toml`),
    join(pkgDir(), "detection", `${agent}.toml`),
  ];
  return candidates.find(existsSync) ?? null;
}

const manifestCache = new Map<string, Manifest | null>();

export function loadManifest(agent: string): Manifest | null {
  if (manifestCache.has(agent)) return manifestCache.get(agent)!;
  const p = manifestPath(agent);
  const m = p ? (load(readFileSync(p, "utf8")) as unknown as Manifest) : null;
  manifestCache.set(agent, m);
  return m;
}

// --- Rust-regex -> JS-regex translation + compilation ---

function translate(pat: string): { source: string; flags: string } {
  let flags = "";
  // hoist inline flags (?i)(?m)(?s) anywhere -> RegExp flags, strip the tokens
  pat = pat.replace(/\(\?([imsx]+)\)/g, (_m, f: string) => {
    for (const c of f) if ("ims".includes(c) && !flags.includes(c)) flags += c;
    return "";
  });
  // \x{2800} -> ⠀  (all manifest code points are BMP)
  let needsU = false;
  pat = pat.replace(/\\x\{([0-9A-Fa-f]+)\}/g, (_m, h: string) => {
    const cp = parseInt(h, 16);
    if (cp <= 0xffff) return "\\u" + cp.toString(16).toUpperCase().padStart(4, "0");
    needsU = true;
    return "\\u{" + cp.toString(16).toUpperCase() + "}";
  });
  if (needsU && !flags.includes("u")) flags += "u";
  // Rust anchors \A (start) and \z/\Z (end) -> JS ^ / $
  pat = pat.replace(/\\A/g, "^").replace(/\\z/g, "$").replace(/\\Z/g, "$");
  return { source: pat, flags };
}

const reCache = new Map<string, RegExp>();

function compile(pat: string): RegExp {
  let r = reCache.get(pat);
  if (r) return r;
  const { source, flags } = translate(pat);
  r = new RegExp(source, flags);
  reCache.set(pat, r);
  return r;
}

// --- condition matching (contains / regex / line_regex / any / all / not) ---

function matchCond(c: Cond, text: string): boolean {
  if (c.contains && !c.contains.every((s) => text.includes(s))) return false;
  if (c.regex && !c.regex.some((p) => compile(p).test(text))) return false;
  if (c.line_regex) {
    const lines = text.split("\n");
    const hit = c.line_regex.some((p) => {
      const re = compile(p);
      return lines.some((l) => re.test(l));
    });
    if (!hit) return false;
  }
  if (c.any && !c.any.some((s) => matchCond(s, text))) return false;
  if (c.all && !c.all.every((s) => matchCond(s, text))) return false;
  if (c.not && c.not.some((s) => matchCond(s, text))) return false;
  return true;
}

// --- region resolution (manifest region name -> text) ---

const RULE_LINE = /^\s*[─-╿\-]{3,}\s*$/; // box-drawing / --- rules
const PROMPT_MARK = /[❯▐›]/; // ❯ ▐ ›
const PROMPT_GT = /^\s*>\s/;
const BOX_TOP = /[╭┌]/; // ╭ ┌
const BOX_BOT = /[╰└]/; // ╰ └

class Regions {
  title: string;
  capture: string;
  lines: string[];
  nonempty: string[];
  cache = new Map<string, string | null>();

  constructor(title: string, capture: string) {
    this.title = title ?? "";
    this.capture = capture ?? "";
    this.lines = this.capture.split("\n");
    this.nonempty = this.lines.filter((l) => l.trim() !== "");
  }

  get(name: string): string | null {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const v = this.build(name);
    this.cache.set(name, v);
    return v;
  }

  build(name: string): string | null {
    const m = name.match(/^(\w+)\((\d+)\)$/);
    if (m) {
      const fn = m[1];
      const n = parseInt(m[2], 10);
      if (fn === "bottom_non_empty_lines") return this.nonempty.slice(-n).join("\n");
      if (fn === "top_non_empty_lines") return this.nonempty.slice(0, n).join("\n");
      return "";
    }
    switch (name) {
      case "osc_title":
        return this.title;
      case "whole_recent":
        return this.capture;
      case "osc_progress":
        return null; // not observable in tmux; rules using it never match
      case "after_last_horizontal_rule": {
        let idx = -1;
        this.lines.forEach((l, i) => {
          if (RULE_LINE.test(l)) idx = i;
        });
        return idx >= 0 ? this.lines.slice(idx + 1).join("\n") : "";
      }
      case "after_last_prompt_marker": {
        // approximation: text from the last prompt line onward (incl. footer)
        let idx = -1;
        this.lines.forEach((l, i) => {
          if (PROMPT_MARK.test(l) || PROMPT_GT.test(l)) idx = i;
        });
        return idx >= 0 ? this.lines.slice(idx).join("\n") : this.capture;
      }
      case "prompt_box_body": {
        // approximation: content between the last box borders near the bottom
        let top = -1;
        let bot = -1;
        this.lines.forEach((l, i) => {
          if (BOX_TOP.test(l)) top = i;
        });
        for (let j = this.lines.length - 1; j >= 0; j--) {
          if (BOX_BOT.test(this.lines[j])) {
            bot = j;
            break;
          }
        }
        if (top >= 0 && top < bot) return this.lines.slice(top + 1, bot).join("\n");
        return this.nonempty.slice(-3).join("\n");
      }
      default:
        return "";
    }
  }
}

// --- engine ---

export interface Classification {
  state: State;
  skip: boolean;
  rule: string | null;
}

export function classifyText(
  agent: string,
  title: string,
  capture: string,
  prev: State | null = null,
): Classification {
  const man = loadManifest(agent);
  if (!man) return { state: "unknown", skip: false, rule: null };

  const R = new Regions(title, capture);
  const rules = [...man.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const rule of rules) {
    const text = R.get(rule.region);
    if (text === null) continue; // unobservable region (osc_progress)
    if (matchCond(rule, text)) {
      if (rule.skip_state_update) return { state: prev ?? "unknown", skip: true, rule: rule.id };
      return { state: rule.state ?? "unknown", skip: false, rule: rule.id };
    }
  }
  return { state: prev ?? "unknown", skip: false, rule: null };
}

// --- tmux helpers + agent detection (shared with tmux-ai-watch) ---

function tmux(...args: string[]): string {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return r.stdout ?? "";
}

export function capturePane(pane: string, lines = 80): string {
  return tmux("capture-pane", "-p", "-t", pane, "-S", `-${lines}`);
}

export function paneTitle(pane: string): string {
  return tmux("display-message", "-p", "-t", pane, "#{pane_title}").replace(/\n$/, "");
}

const VERSION_CMD = /^\d+\.\d+/; // claude often execs as "2.1.227"
const AGENT_TITLE = /[⠀-⣿]|✳|✻|Action Required/;
const CLAUDE_MARKS = [
  "⏵⏵",
  "shift+tab to cycle",
  "auto-compact",
  "? for shortcuts",
  "Bypassing Permissions",
  "✻",
  "Claude Code",
];
const CODEX_MARKS = ["esc to interrupt", "Worked for", "⏎ send", "gpt-5", "Action Required", "codex"];

export function isAgentCandidate(command: string, title: string): boolean {
  return (
    ["claude", "codex", "node", "node.js", "bun", "deno"].includes(command) ||
    VERSION_CMD.test(command || "") ||
    AGENT_TITLE.test(title || "")
  );
}

export function detectAgent(command: string, title: string, capture: string): string | null {
  if (command === "codex") return "codex";
  if (command === "claude") return "claude";
  const blob = `${title || ""}\n${capture || ""}`;
  if (CLAUDE_MARKS.some((m) => blob.includes(m))) return "claude";
  if (CODEX_MARKS.some((m) => blob.includes(m))) return "codex";
  return null;
}

// --- CLI (debug) ---

function cli(argv: string[]): number {
  const cmd = argv[0];
  if ((cmd !== "classify" && cmd !== "explain") || !argv[1]) {
    console.error("usage: tmux-ai-detect {classify|explain} <pane_id> [agent]");
    return 64;
  }
  const pane = argv[1];
  const title = paneTitle(pane);
  const capture = capturePane(pane);
  const agent =
    argv[2] ??
    detectAgent(tmux("display-message", "-p", "-t", pane, "#{pane_current_command}").trim(), title, capture);

  if (!agent) {
    console.error("could not identify agent for pane; pass one explicitly");
    return 1;
  }

  const { state, skip, rule } = classifyText(agent, title, capture);
  if (cmd === "classify") {
    console.log(state);
    return 0;
  }

  // explain
  const man = loadManifest(agent);
  const R = new Regions(title, capture);
  console.log(`agent : ${agent}  (manifest ${man?.version ?? "?"})`);
  console.log(`state : ${state}   skip=${skip}   rule=${rule}`);
  console.log(`title : ${JSON.stringify(title)}`);
  const seen: string[] = [];
  for (const r of man?.rules ?? []) if (!seen.includes(r.region)) seen.push(r.region);
  for (const name of seen) {
    const text = R.get(name);
    console.log(`\n--- region ${name} ---`);
    console.log(text === null ? "<unavailable>" : text);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(cli(process.argv.slice(2)));
}
