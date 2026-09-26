import { TextAttributes, createCliRenderer, type RGBA } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import type { UsageProfile, UsageScene } from "../config.ts"
import { sceneCols, type SceneTime } from "../ui/desert.ts"
import { Line } from "../ui/line.tsx"
import { FPS, easeInOut, easeOut, now, reducedMotion, running, tween, useTicker } from "../ui/motion.ts"
import { flightDone, leaveAfter, type FlightPlan } from "../ui/senu.ts"
import { Sky } from "../ui/sky.tsx"
import { brand, colors, icons, mix, noColor } from "../ui/theme.ts"
import { getSnapshot, readCache } from "./cache.ts"
import {
  BAR_WIDTH,
  LABEL_WIDTH,
  PACE_SLACK,
  bar,
  clockSuffix,
  colorFor,
  evenLeft,
  formatClock,
  formatDuration,
  formatTokens,
  formatUntil,
  markCell,
} from "./format.ts"
import { readToday, spawnTodayRefresh, todayIsFresh, type Today } from "./today.ts"
import { errorSnapshot, nowSeconds, type Banked, type Snapshot, type Spend } from "./types.ts"

const STALE_NOTICE_SECONDS = 10 * 60
const POLL_MS = 1000
const MAX_POLL_SECONDS = 20

const FILL_MS = 250
const STAGGER_MS = 40
const VISION_HOLD_MS = 150
const VISION_MS = 600
const FETCHED_AFTER_MS = 250
const DOTS_MS = 400
const PACE_MARK = brand.papyrus
const TODAY_WATCH_SECONDS = 30

const HEADER = " "
const INDENT = "   "

interface Section {
  snapshot: Snapshot | null
  refreshing: boolean
  justUpdated: boolean
  /** First snapshot arrival on the monotonic now() clock, in ms. */
  loadedAt: number | null
  /** Highlight start on the same clock; null when the initial result arrives within FETCHED_AFTER_MS. */
  landedAt: number | null
}

function vision(landedAt: number | null) {
  if (landedAt == null || !running(landedAt, VISION_MS)) return 0
  return 1 - tween(landedAt + VISION_HOLD_MS, VISION_MS - VISION_HOLD_MS, easeInOut)
}

function Clock({ at, used, right }: { at: number | null; used: number; right: number }) {
  const clock = formatClock(at)
  if (!clock || used + clockSuffix(clock).length > right) return null
  return <span fg={colors.dim}>{clockSuffix(clock)}</span>
}

function Row({ label, left, resetsAt, windowMs, fill, right, children }: {
  label: string
  left: number | null
  resetsAt: number | null
  windowMs?: number | null
  fill: number
  right: number
  children?: ReactNode
}) {
  const color = colorFor(left)
  const shown = left == null ? null : left * fill
  const pct = shown == null ? "n/a" : `${Math.round(shown)}%`
  const reset = formatUntil(resetsAt)
  const even = left == null ? null : evenLeft(resetsAt, windowMs)
  const behind = even != null && left! < even - PACE_SLACK
  const cells = bar(shown)
  const at = even == null ? null : markCell(even)
  const used = INDENT.length + Math.max(label.length, LABEL_WIDTH) + BAR_WIDTH + 5 + "  resets ".length + (reset?.length ?? 0)
  return (
    <Line>
      {INDENT + label.padEnd(LABEL_WIDTH)}
      {at == null ? (
        <span fg={color}>{cells}</span>
      ) : (
        <>
          <span fg={color}>{cells.slice(0, at)}</span>
          <span fg={PACE_MARK}>{"│"}</span>
          <span fg={color}>{cells.slice(at + 1)}</span>
        </>
      )}
      {" ".repeat(5 - pct.length - (behind ? 1 : 0))}
      {behind ? <span fg={PACE_MARK}>{"▾"}</span> : null}
      <span fg={color}>{pct}</span>
      {children}
      {reset ? (
        <>
          <span fg={colors.muted}>{"  resets "}</span>
          <span fg={brand.papyrus}>{reset}</span>
          <Clock at={resetsAt} used={used} right={right} />
        </>
      ) : null}
    </Line>
  )
}

function SpendRow({ spend, fill, cols }: { spend: Spend; fill: number; cols: number }) {
  const color = spend.reached ? colors.bad : colorFor(spend.left)
  const reset = formatUntil(spend.resetsAt)
  const text = ` $${spend.used.toFixed(2)}/$${spend.limit.toFixed(0)}${spend.reached ? " cap reached" : ""}`
  const used = INDENT.length + LABEL_WIDTH + BAR_WIDTH + 5 + text.length
  const gap = reset && used + 2 + reset.length <= cols ? "  " : " "
  const shown = spend.left == null ? null : spend.left * fill
  return (
    <Line>
      {INDENT + "Spend".padEnd(LABEL_WIDTH)}
      <span fg={colorFor(spend.left)}>{bar(shown)}</span>
      <span fg={color}>{" " + (shown == null ? "n/a" : `${Math.round(shown)}%`).padStart(4)}</span>
      <span fg={color}>{` $${spend.used.toFixed(2)}`}</span>
      <span fg={colors.muted}>{`/$${spend.limit.toFixed(0)}`}</span>
      {spend.reached ? <span fg={colors.bad}> cap reached</span> : null}
      {reset ? <span fg={brand.papyrus}>{gap + reset}</span> : null}
      {reset ? <Clock at={spend.resetsAt} used={used + gap.length + reset.length} right={cols - 1} /> : null}
    </Line>
  )
}

function BankedRow({ banked, right }: { banked: Banked; right: number }) {
  const label = INDENT + "Banked".padEnd(LABEL_WIDTH)
  if (banked.available === 0) {
    return (
      <Line>
        {label}
        <span fg={colors.dim}>none</span>
      </Line>
    )
  }
  const expiries = banked.credits.map((c) => c.expiresAt).filter((e): e is number => e != null)
  const soonest = expiries.length ? Math.min(...expiries) : null
  const titles = [...new Set(banked.credits.map((c) => c.title).filter((t): t is string => !!t))].sort()
  const expires = soonest != null ? formatUntil(soonest)! : null
  const tail = titles.length ? "  " + titles.join(" · ") : ""
  const used =
    label.length + banked.available + ` ${banked.available}`.length + (banked.available === 1 ? 6 : 7) +
    (expires ? "  expires ".length + expires.length : 0) + tail.length
  return (
    <Line>
      {label}
      <span fg={colors.good}>{"●".repeat(banked.available)}</span>
      <span fg={brand.papyrus} attributes={TextAttributes.BOLD}>{` ${banked.available}`}</span>
      <span fg={colors.muted}>{banked.available === 1 ? " reset" : " resets"}</span>
      {soonest != null ? (
        <>
          <span fg={colors.muted}>{"  expires "}</span>
          <span fg={brand.papyrus}>{expires}</span>
          <Clock at={soonest} used={used} right={right} />
        </>
      ) : null}
      {tail ? <span fg={colors.dim}>{tail}</span> : null}
    </Line>
  )
}

function freshness(section: Section, dots: string, glow: (fg: RGBA) => RGBA): { text: string; fg: RGBA } {
  const { snapshot } = section
  if (!snapshot) return { text: `fetching${dots}`, fg: colors.muted }
  if (section.justUpdated) return { text: "✓ now updated", fg: glow(colors.good) }
  const age = nowSeconds() - snapshot.updatedAt
  if (section.refreshing) return { text: `${formatDuration(age)} old · refreshing${dots}`, fg: colors.warn }
  return { text: `✓ updated ${age < 60 ? "just now" : `${formatDuration(age)} ago`}`, fg: glow(colors.muted) }
}

function ProfileSection({ profile, section, dots, fillFrom, right }: {
  profile: UsageProfile
  section: Section
  dots: string
  fillFrom: number | null
  right: number
}) {
  const { snapshot } = section
  const codex = profile.kind === "codex"
  const title = `${codex ? icons.codex : icons.claude} ${codex ? "Codex" : "Claude"} · ${profile.name}`
  const plan = snapshot?.planType ? ` · ${snapshot.planType}` : ""
  const lit = vision(section.landedAt)
  const glow = (fg: RGBA) => mix(fg, brand.gold, lit)
  const fresh = freshness(section, dots, glow)
  const pad = Math.max(2, right - HEADER.length - [...title].length - plan.length - [...fresh.text].length)
  const fill = tween(fillFrom, FILL_MS, easeOut)
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line>
        {HEADER}
        <span fg={glow(codex ? colors.codex : colors.claude)} attributes={TextAttributes.BOLD}>{title}</span>
        {plan ? <span fg={colors.muted}>{plan}</span> : null}
        {" ".repeat(pad)}
        <span fg={fresh.fg}>{fresh.text}</span>
      </Line>
      {snapshot && !snapshot.ok ? <Line fg={colors.bad}>{`${INDENT}✗ ${snapshot.error ?? "unknown"}`}</Line> : null}
      {snapshot?.ok
        ? snapshot.limits.map((l) => (
            <Row key={l.label} label={l.label} left={l.left} resetsAt={l.resetsAt} windowMs={l.windowMs} fill={fill} right={right} />
          ))
        : null}
      {snapshot?.ok && snapshot.spend ? <SpendRow spend={snapshot.spend} fill={fill} cols={right + 1} /> : null}
      {snapshot?.ok && snapshot.banked ? <BankedRow banked={snapshot.banked} right={right} /> : null}
    </box>
  )
}

function untilNextMinute(sections: Section[]): number {
  const t = Date.now() / 1000
  const phases: number[] = []
  for (const { snapshot } of sections) {
    if (!snapshot) continue
    phases.push(60 - ((t - snapshot.updatedAt) % 60))
    const resets = [
      ...snapshot.limits.map((l) => l.resetsAt),
      snapshot.spend?.resetsAt,
      ...(snapshot.banked?.credits.map((c) => c.expiresAt) ?? []),
    ]
    for (const at of resets) if (at != null && at > t) phases.push((at - t) % 60 || 60)
  }
  return phases.length ? Math.ceil(Math.min(...phases) * 1000) + 30 : 60_000
}

/** Auto uses local time: dawn 05:30, day 07:00, dusk 17:30, night 19:30. */
export function sceneTime(scene: UsageScene, at = new Date()): SceneTime {
  if (scene !== "auto") return scene
  const minutes = at.getHours() * 60 + at.getMinutes()
  if (minutes >= 5 * 60 + 30 && minutes < 7 * 60) return "dawn"
  if (minutes >= 7 * 60 && minutes < 17 * 60 + 30) return "day"
  if (minutes >= 17 * 60 + 30 && minutes < 19 * 60 + 30) return "dusk"
  return "night"
}

const MODEL_WIDTH = 22
const TOP_MODELS = 3

const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`)
const modelName = (m: string) => m.replace(/-\d{8}$/, "")

function CostSection({ profile, plan, today, watching, dots, right }: {
  profile: UsageProfile
  plan: string | null
  today: Today | null
  watching: boolean
  dots: string
  right: number
}) {
  const codex = profile.kind === "codex"
  const title = `${codex ? icons.codex : icons.claude} ${codex ? "Codex" : "Claude"} · ${profile.name}`
  const planText = plan ? ` · ${plan}` : ""
  const age = today ? nowSeconds() - today.updatedAt : null
  const fresh = watching
    ? { text: `scanning${dots}`, fg: colors.warn }
    : { text: age == null ? "no transcripts today" : `✓ scanned ${age < 60 ? "just now" : `${formatDuration(age)} ago`}`, fg: colors.muted }
  const pad = Math.max(2, right - HEADER.length - [...title].length - planText.length - [...fresh.text].length)
  const models = (today?.models ?? []).slice(0, TOP_MODELS)
  const row = (name: string, cost: string, tokens: number, cached: number) => ({
    name: (INDENT + name).padEnd(INDENT.length + MODEL_WIDTH).slice(0, INDENT.length + MODEL_WIDTH),
    cost: cost.padStart(9),
    tokens: `${formatTokens(tokens)}`.padStart(8) + " tok",
    cached: tokens ? `  ${Math.round((100 * cached) / tokens)}% cached` : "",
  })
  const total = today
    ? row("Today", `${usd(today.costUsd)}${today.unpricedTokens && today.costUsd != null ? "+" : ""}`, today.tokens, today.cachedTokens)
    : null
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line>
        {HEADER}
        <span fg={codex ? colors.codex : colors.claude} attributes={TextAttributes.BOLD}>{title}</span>
        {planText ? <span fg={colors.muted}>{planText}</span> : null}
        {" ".repeat(pad)}
        <span fg={fresh.fg}>{fresh.text}</span>
      </Line>
      {today && !today.tokens ? (
        <Line fg={colors.dim}>{`${INDENT}nothing yet today`}</Line>
      ) : total ? (
        <Line>
          {total.name}
          <span fg={brand.papyrus} attributes={TextAttributes.BOLD}>{total.cost}</span>
          <span fg={colors.fg}>{total.tokens}</span>
          <span fg={colors.muted}>{total.cached}</span>
        </Line>
      ) : null}
      {models.map((m) => {
        const r = row(`  ${modelName(m.model)}`, usd(m.costUsd), m.tokens, m.cachedTokens)
        return (
          <Line key={m.model}>
            <span fg={colors.muted}>{r.name}</span>
            <span fg={colors.muted}>{r.cost}</span>
            <span fg={colors.dim}>{r.tokens}</span>
            <span fg={colors.dim}>{r.cached}</span>
          </Line>
        )
      })}
    </box>
  )
}

type View = "limits" | "cost"

function UsagePopup({ profiles, time }: { profiles: UsageProfile[]; time: SceneTime }) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [sections, setSections] = useState<Section[]>(() =>
    profiles.map(() => ({ snapshot: null, refreshing: false, justUpdated: false, loadedAt: null, landedAt: null })),
  )
  const [tick, setTick] = useState(0)
  const [startedAt] = useState(() => Date.now())
  const [openedAt] = useState(now)
  const leave = useRef<number | null>(null)

  const update = (i: number, patch: Partial<Section>) =>
    setSections((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  useEffect(() => {
    profiles.forEach(async (profile, i) => {
      const snapshot = await getSnapshot(profile).catch((err) =>
        errorSnapshot(err instanceof Error ? err.message : String(err)),
      )
      const t = now()
      update(i, {
        snapshot,
        refreshing: nowSeconds() - snapshot.updatedAt > STALE_NOTICE_SECONDS,
        loadedAt: t,
        landedAt: t - openedAt > FETCHED_AFTER_MS ? t : null,
      })
    })
  }, [])

  const [todays, setTodays] = useState(() => profiles.map((p) => readToday(p)))
  const [watchingToday, setWatchingToday] = useState(() => profiles.map(() => false))
  useEffect(() => {
    const watching = profiles.map((_, i) => !todayIsFresh(todays[i] ?? null))
    if (!watching.some(Boolean)) return
    spawnTodayRefresh(profiles.filter((_, i) => watching[i]))
    setWatchingToday([...watching])
    const since = todays.map((t) => t?.updatedAt ?? 0)
    const started = Date.now()
    const id = setInterval(() => {
      const landed = profiles.map((p, i) => {
        const t = watching[i] ? readToday(p) : null
        return t && t.updatedAt > since[i]! ? t : null
      })
      if (landed.some(Boolean)) setTodays((prev) => prev.map((t, i) => landed[i] ?? t))
      landed.forEach((t, i) => t && (watching[i] = false))
      if (Date.now() - started >= TODAY_WATCH_SECONDS * 1000) watching.fill(false)
      setWatchingToday([...watching])
      if (!watching.some(Boolean)) clearInterval(id)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [])

  const refreshing = sections.some((s) => s.refreshing)
  const busy = sections.some((s) => !s.snapshot || s.refreshing)

  useEffect(() => {
    if (!refreshing) return
    const id = setInterval(() => setTick((t) => t + 1), POLL_MS)
    return () => clearInterval(id)
  }, [refreshing])
  useEffect(() => {
    if (busy) return
    const id = setTimeout(() => setTick((t) => t + 1), untilNextMinute(sections))
    return () => clearTimeout(id)
  }, [busy, tick])

  useEffect(() => {
    const watchedOut = Date.now() - startedAt >= MAX_POLL_SECONDS * 1000
    sections.forEach((section, i) => {
      if (!section.refreshing || !section.snapshot) return
      const fresh = readCache(profiles[i]!)?.snapshot
      if (fresh && fresh.updatedAt > section.snapshot.updatedAt) {
        update(i, { snapshot: fresh, refreshing: false, justUpdated: true, landedAt: now() })
      } else if (watchedOut) {
        update(i, { refreshing: false })
      }
    })
  }, [tick])

  const [view, setView] = useState<View>("limits")
  useKeyboard((key) => {
    if (key.name === "c" || key.name === "t") setView("cost")
    else if (key.name === "l") setView("limits")
    else if (key.name === "tab") setView((v) => (v === "limits" ? "cost" : "limits"))
    else renderer.destroy()
  })

  const t = now()
  const cols = sceneCols(width)
  if (!busy && leave.current == null) leave.current = leaveAfter(t - openedAt)
  const plan: FlightPlan = {
    t: t - openedAt,
    busy: busy && !reducedMotion,
    marks: sections.map((s) => s.landedAt).filter((at): at is number => at != null).map((at) => at - openedAt),
    leave: leave.current,
    perched: reducedMotion || noColor,
    time,
    cols,
  }
  const flying = !noColor && !flightDone(plan)

  const fillFrom = sections.map((s, i) =>
    s.landedAt ?? (s.loadedAt == null ? null : Math.max(s.loadedAt, openedAt + STAGGER_MS * (i + 1))),
  )
  const tweening =
    fillFrom.some((from) => running(from, FILL_MS, t)) || sections.some((s) => running(s.landedAt, VISION_MS, t))
  useTicker(flying || tweening ? FPS : busy ? 1000 / DOTS_MS : 0)

  const dots = reducedMotion ? "..." : ".".repeat((Math.floor((t - openedAt) / DOTS_MS) % 3) + 1)
  const right = Math.min(cols, width) - 1
  const note = busy ? "senu is circling" : flightDone(plan) ? "senu keeps watch" : "senu comes in to land"
  const hint = view === "limits" ? "c cost · any other key closes" : "l limits · any other key closes"

  return (
    <box flexDirection="column" height={height} gap={1}>
      <box flexDirection="column" gap={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {noColor ? null : <Sky plan={plan} width={width} />}
        {profiles.map((profile, i) =>
          view === "limits" ? (
            <ProfileSection
              key={`${profile.kind}:${profile.name}`}
              profile={profile}
              section={sections[i]!}
              dots={dots}
              fillFrom={fillFrom[i]!}
              right={right}
            />
          ) : (
            <CostSection
              key={`${profile.kind}:${profile.name}`}
              profile={profile}
              plan={sections[i]!.snapshot?.planType ?? null}
              today={todays[i] ?? null}
              watching={watchingToday[i]!}
              dots={dots}
              right={right}
            />
          ),
        )}
      </box>
      <Line>
        {HEADER}
        <span fg={colors.muted} attributes={TextAttributes.DIM}>{hint}</span>
        {" ".repeat(Math.max(2, right - HEADER.length - hint.length - note.length))}
        <span fg={busy ? brand.dusk : brand.shadow}>{note}</span>
      </Line>
    </box>
  )
}

export async function runUsagePopup(profiles: UsageProfile[], scene: UsageScene): Promise<number> {
  const { promise: closed, resolve } = Promise.withResolvers<void>()
  const renderer = await createCliRenderer({ useMouse: false, onDestroy: resolve })
  createRoot(renderer).render(<UsagePopup profiles={profiles} time={sceneTime(scene)} />)
  await closed
  // In-flight snapshot fetches can keep a closed tmux popup alive and leave it blank.
  process.exit(0)
}
