import type { Config } from "../config.ts"
import { classify, explain } from "./engine.ts"
import { parseAgent, type Agent } from "./manifest.ts"
import { capturePane, capturePanes, findPane, identifyAgents, listAgentPanes, tmux } from "./panes.ts"
import type { DetectionInput } from "./regions.ts"

const HELP = `usage: senu scout [pane] [agent]
       senu scout explain <pane> [agent]
       senu scout manifest refresh [--check] [--daily]

Without a pane, scout lists every agent pane and its state.
With a pane, it prints that pane's state: working, blocked, idle or unknown.
explain dumps every rule's verdict and the regions they read.
scout shows pane IDs such as %8; agent (claude or codex) is found from the
pane if omitted.
`

async function readPane(name: string, args: string[]): Promise<{ agent: Agent; input: DetectionInput } | number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP)
    return 0
  }
  const [explicitTarget, agentArg, ...extra] = args
  if (extra.length) {
    process.stderr.write(HELP)
    return 2
  }
  const target = explicitTarget
  if (!target) {
    console.error(`senu ${name}: pass a pane from the list shown by senu scout`)
    return 2
  }

  let agent: Agent | null = null
  if (agentArg) {
    agent = parseAgent(agentArg)
    if (!agent) {
      console.error(`senu ${name}: unknown agent "${agentArg}" (have claude, codex)`)
      return 2
    }
  }

  const pane = await findPane(target)
  if (!pane) {
    console.error(`senu ${name}: no pane "${target}"`)
    return 1
  }
  agent ??= (await identifyAgents([pane]))[0]?.agent ?? null
  if (!agent) {
    console.error(`senu ${name}: no agent found in ${pane.id} (it runs ${pane.command}); pass one explicitly`)
    return 1
  }
  const screen = await capturePane(pane.id)
  if (screen === null) {
    console.error(`senu ${name}: could not capture ${pane.id}`)
    return 1
  }
  return { agent, input: { screen, oscTitle: pane.oscTitle } }
}

export async function classifyCommand(args: string[], _config: Config): Promise<number> {
  const read = await readPane("scout", args)
  if (typeof read === "number") return read
  console.log(classify(read.agent, read.input).state)
  return 0
}

export async function explainCommand(args: string[], _config: Config): Promise<number> {
  const read = await readPane("scout explain", args)
  if (typeof read === "number") return read
  const x = explain(read.agent, read.input)
  const { manifest, source, warning } = x.loaded

  const out: string[] = []
  out.push(`agent  : ${x.agent}  (manifest ${manifest.version ?? "?"}, ${source})`)
  if (warning) out.push(`warning: ${warning}`)
  out.push(`state  : ${x.state}`)
  if (x.rule) {
    const flags = [x.skipStateUpdate && "skip_state_update", x.visibleIdle && "visible_idle", x.visibleBlocker && "visible_blocker", x.visibleWorking && "visible_working"]
    const extra = flags.filter(Boolean).join(", ")
    out.push(`rule   : ${x.rule.id}  (priority ${x.rule.priority}, region ${x.rule.region}${extra ? `; ${extra}` : ""})`)
  } else {
    out.push(`rule   : none  (fallback ${x.fallback})`)
  }
  out.push(`title  : ${JSON.stringify(read.input.oscTitle)}`)

  out.push("", "rules, in file order (* won, + matched):")
  const idWidth = Math.max(...x.evaluated.map((e) => e.rule.id.length))
  for (const e of x.evaluated) {
    const mark = e.rule === x.rule ? "*" : e.matched ? "+" : " "
    out.push(`  ${mark} ${e.rule.id.padEnd(idWidth)}  ${String(e.rule.priority).padStart(5)}  ${e.rule.state.padEnd(7)}  ${e.rule.region}`)
  }

  const seen = new Set<string>()
  for (const e of x.evaluated) {
    if (seen.has(e.rule.region)) continue
    seen.add(e.rule.region)
    out.push("", `--- region ${e.rule.region} ---`, e.text === "" ? "<empty>" : e.text.replace(/\n$/, ""))
  }
  console.log(out.join("\n"))
  return 0
}

async function scanCommand(): Promise<number> {
  if (!(await tmux("display-message", "-p", "#{socket_path}")).ok) {
    console.error("senu scout: no tmux server")
    return 1
  }
  const panes = await listAgentPanes()
  if (!panes.length) {
    console.log("no agent panes")
    return 0
  }
  const screens = await capturePanes(panes.map((p) => p.id))
  let failed = false
  for (const pane of panes) {
    const screen = screens.get(pane.id)
    if (screen === undefined) {
      console.error(`senu scout: could not capture ${pane.id}`)
      failed = true
      continue
    }
    const state = classify(pane.agent, { screen, oscTitle: pane.oscTitle }).state
    console.log(`${pane.id.padEnd(4)}  ${pane.agent.padEnd(6)}  ${state.padEnd(7)}  ${pane.session}:${pane.windowIndex} ${pane.windowName}`)
  }
  return failed ? 1 : 0
}

export async function scoutCommand(args: string[], config: Config): Promise<number> {
  const [sub, ...rest] = args
  if (sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(HELP)
    return 0
  }
  if (sub === "explain") return explainCommand(rest, config)
  if (sub === "manifest") return (await import("./refresh.ts")).manifestsCommand(rest, config)
  if (!sub) return scanCommand()
  return classifyCommand(args, config)
}
