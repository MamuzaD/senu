import { TextAttributes, createCliRenderer, type RGBA } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useEffectEvent, useState, type ReactNode } from "react"

import type { UsageProfile, UsageScene } from "~/config.ts"
import { CanvasView } from "~/ui/canvas.tsx"
import { SCENE_ROWS, sceneCols, type SceneTime } from "~/ui/desert.ts"
import { Line } from "~/ui/line.tsx"
import {
  FPS,
  easeInOut,
  easeOut,
  now,
  reducedMotion,
  running,
  tween,
  useTicker,
} from "~/ui/motion.ts"
import { flightDone, leaveAfter, type FlightPlan } from "~/ui/senu.ts"
import { Sky } from "~/ui/sky.tsx"
import { brand, colors, icons, mix, noColor } from "~/ui/theme.ts"

import { getSnapshot, readCache } from "./cache.ts"
import { axisLine, stackedBars } from "./chart.ts"
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
import {
  RANGE_DAYS,
  readToday,
  spawnTodayRefresh,
  todayIsFresh,
  type Bucket,
  type RangeDays,
  type RangeTotals,
  type Today,
} from "./today.ts"
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

function Row({
  label,
  left,
  resetsAt,
  windowMs,
  fill,
  right,
  children,
}: {
  label: string
  left: number | null
  resetsAt: number | null
  windowMs?: number | null | undefined
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
  const used =
    INDENT.length +
    Math.max(label.length, LABEL_WIDTH) +
    BAR_WIDTH +
    5 +
    "  resets ".length +
    (reset?.length ?? 0)
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
      {reset ? (
        <Clock at={spend.resetsAt} used={used + gap.length + reset.length} right={cols - 1} />
      ) : null}
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
  const titles = [
    ...new Set(banked.credits.map((c) => c.title).filter((t): t is string => !!t)),
  ].toSorted()
  const expires = soonest != null ? formatUntil(soonest)! : null
  const tail = titles.length ? "  " + titles.join(" · ") : ""
  const used =
    label.length +
    banked.available +
    ` ${banked.available}`.length +
    (banked.available === 1 ? 6 : 7) +
    (expires ? "  expires ".length + expires.length : 0) +
    tail.length
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

function freshness(
  section: Section,
  dots: string,
  glow: (fg: RGBA) => RGBA,
): { text: string; fg: RGBA } {
  const { snapshot } = section
  if (!snapshot) return { text: `fetching${dots}`, fg: colors.muted }
  if (section.justUpdated) return { text: "✓ now updated", fg: glow(colors.good) }
  const age = nowSeconds() - snapshot.updatedAt
  if (section.refreshing)
    return { text: `${formatDuration(age)} old · refreshing${dots}`, fg: colors.warn }
  return {
    text: `✓ updated ${age < 60 ? "just now" : `${formatDuration(age)} ago`}`,
    fg: glow(colors.muted),
  }
}

function ProfileSection({
  profile,
  section,
  dots,
  fillFrom,
  right,
}: {
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
  const pad = Math.max(
    2,
    right - HEADER.length - Bun.stringWidth(title) - plan.length - Bun.stringWidth(fresh.text),
  )
  const fill = tween(fillFrom, FILL_MS, easeOut)
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line>
        {HEADER}
        <span fg={glow(codex ? colors.codex : colors.claude)} attributes={TextAttributes.BOLD}>
          {title}
        </span>
        {plan ? <span fg={colors.muted}>{plan}</span> : null}
        {" ".repeat(pad)}
        <span fg={fresh.fg}>{fresh.text}</span>
      </Line>
      {snapshot && !snapshot.ok ? (
        <Line fg={colors.bad}>{`${INDENT}✗ ${snapshot.error ?? "unknown"}`}</Line>
      ) : null}
      {snapshot?.ok
        ? snapshot.limits.map((l) => (
            <Row
              key={l.label}
              label={l.label}
              left={l.left}
              resetsAt={l.resetsAt}
              windowMs={l.windowMs}
              fill={fill}
              right={right}
            />
          ))
        : null}
      {snapshot?.ok && snapshot.spend ? (
        <SpendRow spend={snapshot.spend} fill={fill} cols={right + 1} />
      ) : null}
      {snapshot?.ok && snapshot.banked ? (
        <BankedRow banked={snapshot.banked} right={right} />
      ) : null}
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

const RANGE_LABEL: Record<RangeDays, string> = { 1: "today", 7: "7d", 30: "30d" }
export type Breakdown = "profile" | "model"
export const BREAKDOWNS: readonly Breakdown[] = ["profile", "model"]
const BREAKDOWN_LABEL: Record<Breakdown, string> = { profile: "by profile", model: "by model" }
const COST_FIXED_ROWS = 9
const GAP_ROWS = 1
const FOOTER_ROWS = 1 + GAP_ROWS
const MIN_CHART_ROWS = 3
const MAX_CHART_ROWS = 12
const MIN_BREAKDOWN_ROWS = 3
const MAX_BREAKDOWN_ROWS = 6
const SHARE_COLS = 7
const VALUE_COLS = 10 + SHARE_COLS + 10

const money = (v: number | null) =>
  v == null
    ? "—"
    : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
function percent(part: number, whole: number): string {
  if (!(whole > 0)) return "—"
  const share = Math.round((100 * part) / whole)
  return share === 0 && part > 0 ? "<1%" : `${share}%`
}
const modelName = (m: string) => m.replace(/-\d{8}$/, "")
const kindColor = (kind: UsageProfile["kind"]) => (kind === "codex" ? colors.codex : colors.claude)
const kindTitle = (kind: UsageProfile["kind"]) =>
  kind === "codex" ? `${icons.codex} Codex` : `${icons.claude} Claude`

function bucketLabel(label: string, days: RangeDays): string {
  if (days === 1) return `${label}h`
  const date = bucketDate(label)
  return days === 7
    ? `${date.toLocaleDateString("en-US", { weekday: "short" })} ${date.getDate()}`
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

const bucketDate = (label: string) => {
  const [y = 0, m = 1, d = 1] = label.split("-").map(Number)
  return new Date(y, m - 1, d)
}

type AxisPick = (i: number, buckets: Bucket[]) => boolean
const MIN_DAYS_BEFORE_TODAY = 3

const everyNthHour =
  (n: number): AxisPick =>
  (i) =>
    i % n === 0
const everyNthDayBack =
  (n: number): AxisPick =>
  (i, b) =>
    (b.length - 1 - i) % n === 0
const mondaysAndToday =
  (everyWeeks: number): AxisPick =>
  (i, b) => {
    const daysBack = b.length - 1 - i
    if (daysBack === 0) return true
    return (
      bucketDate(b[i]!.label).getDay() === 1 &&
      daysBack >= MIN_DAYS_BEFORE_TODAY &&
      Math.round(daysBack / 7) % everyWeeks === 0
    )
  }

const AXIS_PICKS: Record<RangeDays, AxisPick[]> = {
  1: [3, 6, 12].map(everyNthHour),
  7: [1, 2].map(everyNthDayBack),
  30: [1, 2].map(mondaysAndToday),
}

function axis(buckets: Bucket[], days: RangeDays, width: number): string {
  for (const pick of AXIS_PICKS[days]) {
    const labels = buckets.map((b, i) => (pick(i, buckets) ? bucketLabel(b.label, days) : null))
    const line = axisLine(labels, width)
    if (line) return line
  }
  return ""
}

export function CostView({
  profiles,
  todays,
  watching,
  days,
  breakdown,
  dots,
  right,
  rows,
}: {
  profiles: UsageProfile[]
  todays: (Today | null)[]
  watching: boolean[]
  days: RangeDays
  breakdown: Breakdown
  dots: string
  right: number
  rows: number
}) {
  const totals = todays.map((t) => t?.ranges?.find((r) => r.days === days) ?? null)
  const known = totals.filter((r): r is RangeTotals => r != null)
  const sum = (pick: (r: RangeTotals) => number) => known.reduce((n, r) => n + pick(r), 0)
  const priced = known.some((r) => r.costUsd != null)
  const cost = priced ? sum((r) => r.costUsd ?? 0) : null
  const tokens = sum((r) => r.tokens)
  const unpriced = sum((r) => r.unpricedTokens)
  const scanning = watching.some(Boolean)

  const buckets = known[0]?.buckets ?? []
  const stacks = buckets.map((_, i) => {
    const stack = { lower: 0, upper: 0 }
    totals.forEach((r, p) => {
      const v = r?.buckets[i]?.costUsd ?? 0
      if (profiles[p]!.kind === "codex") stack.lower += v
      else stack.upper += v
    })
    return stack
  })
  const peak = Math.max(0, ...stacks.map((s) => s.lower + s.upper))

  const models = new Map<
    string,
    {
      kind: UsageProfile["kind"]
      name: string
      cost: number | null
      tokens: number
      usedBy: { profile: string; tokens: number }[]
    }
  >()
  totals.forEach((r, p) => {
    const { kind, name: profile } = profiles[p]!
    for (const m of r?.models ?? []) {
      const key = `${kind}:${modelName(m.model)}`
      const held = models.get(key) ?? {
        kind,
        name: modelName(m.model),
        cost: null,
        tokens: 0,
        usedBy: [],
      }
      held.tokens += m.tokens
      if (m.costUsd != null) held.cost = (held.cost ?? 0) + m.costUsd
      held.usedBy.push({ profile, tokens: m.tokens })
      models.set(key, held)
    }
  })
  const ranked = [...models.values()].toSorted(
    (a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.tokens - a.tokens,
  )

  const idle = (r: RangeTotals | null) => r != null && r.tokens === 0
  const active = profiles.flatMap((_, p) => (idle(totals[p] ?? null) ? [] : [p]))

  const breakdownRows = Math.max(MIN_BREAKDOWN_ROWS, Math.min(MAX_BREAKDOWN_ROWS, profiles.length))
  const chartRows = Math.max(
    MIN_CHART_ROWS,
    Math.min(MAX_CHART_ROWS, rows - COST_FIXED_ROWS - breakdownRows),
  )
  const contentWidth = right + 1 - 2 * INDENT.length
  const chartWidth = contentWidth
  const chart = stackedBars(stacks, chartWidth, chartRows, colors.codex, colors.claude)

  const oldest = known.length ? Math.min(...todays.map((t) => t?.updatedAt ?? Infinity)) : null
  const status = scanning
    ? { text: `scanning${dots}`, fg: colors.warn }
    : oldest == null || !Number.isFinite(oldest)
      ? { text: "no transcripts", fg: colors.muted }
      : {
          text: `✓ scanned ${nowSeconds() - oldest < 60 ? "just now" : `${formatDuration(nowSeconds() - oldest)} ago`}`,
          fg: colors.muted,
        }

  const nameWidth = contentWidth - VALUE_COLS
  const valueCells = (costText: string, share: string, tok: string) =>
    costText.padStart(10) + share.padStart(SHARE_COLS) + tok.padStart(10)

  const tabsWidth = RANGE_DAYS.reduce((n, d) => n + RANGE_LABEL[d].length + 2, 0)
  const switchWidth = BREAKDOWNS.reduce((n, b) => n + BREAKDOWN_LABEL[b].length + 2, 0)
  const headline = money(cost) + (unpriced && cost != null ? "+" : "")
  const detail = [
    "API estimate",
    `${sum((r) => r.sessions)} sessions`,
    `${formatTokens(tokens)} tok`,
    ...(unpriced ? [`${formatTokens(unpriced)} unpriced`] : []),
  ].join(" · ")
  const title = days === 1 ? "hourly cost" : "daily cost"
  const peakText = peak ? `peak ${money(peak)}` : ""

  return (
    <box flexDirection="column" flexShrink={0}>
      <Line>
        {HEADER}
        {RANGE_DAYS.map((d) => (
          <span key={d}>
            {" "}
            {d === days ? (
              <span fg={brand.papyrus} attributes={TextAttributes.BOLD | TextAttributes.UNDERLINE}>
                {RANGE_LABEL[d]}
              </span>
            ) : (
              <span fg={colors.dim}>{RANGE_LABEL[d]}</span>
            )}{" "}
          </span>
        ))}
        {" ".repeat(Math.max(2, right - HEADER.length - tabsWidth - Bun.stringWidth(status.text)))}
        <span fg={status.fg}>{status.text}</span>
      </Line>
      <Line>
        {HEADER}
        <span fg={brand.papyrus} attributes={TextAttributes.BOLD}>
          {headline}
        </span>
        <span fg={colors.muted}>{`  ${detail}`}</span>
      </Line>
      <Line> </Line>
      <Line>
        {INDENT}
        <span fg={colors.muted}>{title}</span>
        {" ".repeat(Math.max(2, chartWidth - title.length - peakText.length))}
        <span fg={colors.dim}>{peakText}</span>
      </Line>
      {peak ? (
        <box flexDirection="row" flexShrink={0}>
          <text>{INDENT}</text>
          <CanvasView canvas={chart} />
        </box>
      ) : (
        Array.from({ length: chartRows }, (_, i) => (
          <Line key={i} fg={colors.dim}>
            {i === Math.floor(chartRows / 2)
              ? `${INDENT}${scanning ? `scanning${dots}` : "no usage in this range"}`
              : " "}
          </Line>
        ))
      )}
      <Line fg={colors.dim}>
        {INDENT}
        {axis(buckets, days, chartWidth)}
      </Line>
      <Line> </Line>
      <Line>
        {" ".repeat(INDENT.length - 1)}
        {BREAKDOWNS.map((b) => (
          <span key={b}>
            {" "}
            {b === breakdown ? (
              <span fg={brand.papyrus} attributes={TextAttributes.BOLD | TextAttributes.UNDERLINE}>
                {BREAKDOWN_LABEL[b]}
              </span>
            ) : (
              <span fg={colors.dim}>{BREAKDOWN_LABEL[b]}</span>
            )}{" "}
          </span>
        ))}
        <span fg={colors.dim}>
          {" ".repeat(Math.max(1, nameWidth - switchWidth + 1))}
          {valueCells("cost", "share", "tokens")}
        </span>
      </Line>
      {breakdown === "profile"
        ? active.slice(0, breakdownRows).map((p) => {
            const profile = profiles[p]!
            const r = totals[p]
            const name = `${kindTitle(profile.kind)} · ${profile.name}`
            const pad = " ".repeat(Math.max(1, nameWidth - Bun.stringWidth(name) - 2))
            return (
              <Line key={`${profile.kind}:${profile.name}`}>
                {INDENT}
                <span fg={kindColor(profile.kind)}>{`● ${name}`}</span>
                {pad}
                {r ? (
                  <>
                    <span fg={colors.fg}>{money(r.costUsd).padStart(10)}</span>
                    <span fg={colors.muted}>
                      {percent(r.costUsd ?? 0, cost ?? 0).padStart(SHARE_COLS)}
                    </span>
                    <span fg={colors.dim}>{`${formatTokens(r.tokens)} tok`.padStart(10)}</span>
                  </>
                ) : (
                  <span fg={colors.muted}>
                    {(watching[p] ? `scanning${dots}` : "—").padStart(VALUE_COLS)}
                  </span>
                )}
              </Line>
            )
          })
        : ranked.slice(0, breakdownRows).map((m) => {
            const tag = m.usedBy
              .toSorted((a, b) => b.tokens - a.tokens)
              .map((b) => b.profile)
              .join(" · ")
            const room = nameWidth - 2
            const name = m.name.length > room ? `${m.name.slice(0, room - 1)}…` : m.name
            const tagText = tag && name.length + 2 + tag.length <= room ? `  ${tag}` : ""
            return (
              <Line key={`${m.kind}:${m.name}`}>
                {INDENT}
                <span fg={kindColor(m.kind)}>● </span>
                <span fg={colors.muted}>{name}</span>
                <span fg={colors.dim}>{tagText.padEnd(room - name.length)}</span>
                <span fg={colors.fg}>
                  {(m.cost == null ? "unpriced" : money(m.cost)).padStart(10)}
                </span>
                <span fg={colors.muted}>
                  {(m.cost == null ? "—" : percent(m.cost, cost ?? 0)).padStart(SHARE_COLS)}
                </span>
                <span fg={colors.dim}>{`${formatTokens(m.tokens)} tok`.padStart(10)}</span>
              </Line>
            )
          })}
      {Array.from(
        {
          length: Math.max(
            0,
            breakdownRows - (breakdown === "profile" ? active.length : ranked.length),
          ),
        },
        (_, i) => (
          <Line key={`pad${i}`}> </Line>
        ),
      )}
      <Line> </Line>
      <Line fg={colors.muted}>
        {INDENT}
        {[
          `cached ${formatTokens(sum((r) => r.cachedTokens))}`,
          `uncached ${formatTokens(sum((r) => r.uncachedTokens))}`,
          `output ${formatTokens(sum((r) => r.outputTokens))}`,
          `cache saved ${money(priced ? sum((r) => r.cacheSavingsUsd ?? 0) : null)}`,
        ].join(" · ")}
      </Line>
    </box>
  )
}

type View = "limits" | "cost"

function UsagePopup({ profiles, time }: { profiles: UsageProfile[]; time: SceneTime }) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [sections, setSections] = useState<Section[]>(() =>
    profiles.map(() => ({
      snapshot: null,
      refreshing: false,
      justUpdated: false,
      loadedAt: null,
      landedAt: null,
    })),
  )
  const [tick, setTick] = useState(0)
  const [startedAt] = useState(() => Date.now())
  const [openedAt] = useState(now)
  const [leave, setLeave] = useState<number | null>(null)

  const update = (i: number, patch: Partial<Section>) =>
    setSections((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  // Fetch each profile once when the popup opens.
  const loadSnapshots = useEffectEvent(() => {
    profiles.forEach((profile, i) => {
      void getSnapshot(profile)
        .catch((err) => errorSnapshot(err instanceof Error ? err.message : String(err)))
        .then((snapshot) => {
          const t = now()
          update(i, {
            snapshot,
            refreshing: nowSeconds() - snapshot.updatedAt > STALE_NOTICE_SECONDS,
            loadedAt: t,
            landedAt: t - openedAt > FETCHED_AFTER_MS ? t : null,
          })
        })
    })
  })
  useEffect(() => loadSnapshots(), [])

  const [todays, setTodays] = useState(() => profiles.map((p) => readToday(p)))
  const [watchingToday, setWatchingToday] = useState(() =>
    profiles.map((_, i) => !todayIsFresh(todays[i] ?? null)),
  )
  // Watch the initial totals until each refresh lands or times out.
  const watchToday = useEffectEvent(() => {
    const watching = profiles.map((_, i) => !todayIsFresh(todays[i] ?? null))
    if (!watching.some(Boolean)) return
    spawnTodayRefresh(profiles.filter((_, i) => watching[i]))
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
  })
  useEffect(() => watchToday(), [])

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
  }, [busy, tick, sections])

  // Runs on each tick, reading sections as of that tick.
  const checkCache = useEffectEvent(() => {
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
  })
  useEffect(() => checkCache(), [tick])

  const [view, setView] = useState<View>("limits")
  const [range, setRange] = useState(0)
  const [breakdown, setBreakdown] = useState<Breakdown>("profile")
  useKeyboard((key) => {
    const k = key.name
    const back = k === "h" || k === "left" || key.sequence === "["
    if (view === "cost" && (back || k === "l" || k === "right" || key.sequence === "]")) {
      const step = back ? RANGE_DAYS.length - 1 : 1
      setRange((r) => (r + step) % RANGE_DAYS.length)
    } else if (view === "cost" && (k === "j" || k === "k" || k === "down" || k === "up")) {
      setBreakdown((b) => (b === "profile" ? "model" : "profile"))
    } else if (k === "c" || k === "t") setView("cost")
    else if (k === "tab") setView((v) => (v === "limits" ? "cost" : "limits"))
    else if (k === "q" || k === "escape") renderer.destroy()
  })

  const t = now()
  const cols = sceneCols(width)
  if (!busy && leave == null) setLeave(leaveAfter(t - openedAt))
  const plan: FlightPlan = {
    t: t - openedAt,
    busy: busy && !reducedMotion,
    marks: sections
      .map((s) => s.landedAt)
      .filter((at): at is number => at != null)
      .map((at) => at - openedAt),
    leave,
    perched: reducedMotion || noColor,
    time,
    cols,
  }
  const flying = !noColor && !flightDone(plan)

  const fillFrom = sections.map(
    (s, i) =>
      s.landedAt ??
      (s.loadedAt == null ? null : Math.max(s.loadedAt, openedAt + STAGGER_MS * (i + 1))),
  )
  const tweening =
    fillFrom.some((from) => running(from, FILL_MS, t)) ||
    sections.some((s) => running(s.landedAt, VISION_MS, t))
  useTicker(flying || tweening ? FPS : busy ? 1000 / DOTS_MS : 0)

  const dots = reducedMotion ? "..." : ".".repeat((Math.floor((t - openedAt) / DOTS_MS) % 3) + 1)
  const right = Math.min(cols, width) - 1
  const note = busy
    ? "senu is circling"
    : flightDone(plan)
      ? "senu keeps watch"
      : "senu comes in to land"
  const hint =
    view === "limits" ? "c cost · q quit" : "←/→ range · ↑/↓ breakdown · tab limits · q quit"
  const costRows = height - (noColor ? 0 : SCENE_ROWS + GAP_ROWS) - FOOTER_ROWS

  return (
    <box flexDirection="column" height={height} gap={1}>
      <box flexDirection="column" gap={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {noColor ? null : <Sky plan={plan} width={width} />}
        {view === "limits" ? (
          profiles.map((profile, i) => (
            <ProfileSection
              key={`${profile.kind}:${profile.name}`}
              profile={profile}
              section={sections[i]!}
              dots={dots}
              fillFrom={fillFrom[i]!}
              right={right}
            />
          ))
        ) : (
          <CostView
            profiles={profiles}
            todays={todays}
            watching={watchingToday}
            days={RANGE_DAYS[range]!}
            breakdown={breakdown}
            dots={dots}
            right={right}
            rows={costRows}
          />
        )}
      </box>
      <Line>
        {HEADER}
        <span fg={colors.muted} attributes={TextAttributes.DIM}>
          {hint}
        </span>
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
