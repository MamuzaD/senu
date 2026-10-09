import { TextAttributes, createCliRenderer, type RGBA } from "@opentui/core"
import { type Binding } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, useActiveKeys, useBindings } from "@opentui/keymap/react"
import { createRoot, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useEffectEvent, useState, type ReactNode } from "react"

import type { UsageProfile, UsageScene } from "~/config.ts"
import { Canvas, CanvasView } from "~/ui/canvas.tsx"
import { SCENE_COLS, SCENE_ROWS, sceneCols, type SceneTime } from "~/ui/desert.ts"
import { hopAt, hopDone, hopRunning, paintHop, type Hop, type Point } from "~/ui/gaze.ts"
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
import { flightDone, leaveAfter, snagAt, type FlightPlan } from "~/ui/senu.ts"
import { Sky } from "~/ui/sky.tsx"
import { brand, colors, icons, mix, noColor } from "~/ui/theme.ts"
import { UpdateGate, updateGate } from "~/update/gate.tsx"
import { newerRelease } from "~/update/release.ts"

import { getSnapshot, readCache } from "./cache.ts"
import { axis, stackedBars } from "./chart.ts"
import {
  BAR_WIDTH,
  INDENT,
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
  money,
} from "./format.ts"
import { Glance, glanceRows, glanceStacks } from "./glance.tsx"
import {
  RANGE_DAYS,
  RANGE_LABEL,
  readToday,
  spawnTodayRefresh,
  todayIsFresh,
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
/** Columns kept clear right of the limits for senu to perch beside the profile it looks at. */
const GUTTER = 7
const FETCHED_AFTER_MS = 250
const DOTS_MS = 400
const PACE_MARK = brand.papyrus
const TODAY_WATCH_SECONDS = 30

const HEADER = " "

export interface Section {
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
  // Codex reports the cap in workspace credits, not dollars.
  const amount = ` ${spend.used.toFixed(2)}/${spend.limit.toFixed(0)} credits`
  const start = INDENT.length + LABEL_WIDTH + BAR_WIDTH + 5 + amount.length
  // The red empty bar already says the cap is reached, so the words give way to the reset first.
  const capped =
    spend.reached && (!reset || start + " cap reached".length + 2 + reset.length <= cols)
  const used = start + (capped ? " cap reached".length : 0)
  const gap = reset && used + 2 + reset.length <= cols ? "  " : " "
  const shown = spend.left == null ? null : spend.left * fill
  return (
    <Line>
      {INDENT + "Spend".padEnd(LABEL_WIDTH)}
      <span fg={colorFor(spend.left)}>{bar(shown)}</span>
      <span fg={color}>{" " + (shown == null ? "n/a" : `${Math.round(shown)}%`).padStart(4)}</span>
      <span fg={color}>{` ${spend.used.toFixed(2)}`}</span>
      <span fg={colors.muted}>{`/${spend.limit.toFixed(0)} credits`}</span>
      {capped ? <span fg={colors.bad}> cap reached</span> : null}
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

/** The worst thing about a profile, for a title line folded down to make room. */
function statusOf(snapshot: Snapshot | null): { text: string; fg: RGBA } | null {
  if (!snapshot) return null
  if (!snapshot.ok) return { text: "✗ error", fg: colors.bad }
  const t = nowSeconds()
  const levels = [
    // A window past its reset has refilled, whatever the cache last saw.
    ...snapshot.limits.map((l) => ({
      label: l.label,
      left: l.resetsAt != null && l.resetsAt <= t ? 100 : l.left,
    })),
    // As in the pace line, the spend cap matters only when there's no plan limit to fall back on.
    ...(snapshot.spend && !snapshot.limits.length
      ? [{ label: "Spend", left: snapshot.spend.left }]
      : []),
  ].filter((l): l is { label: string; left: number } => l.left != null)
  if (!levels.length) return { text: "limits n/a", fg: colors.dim }
  const low = levels.reduce((a, b) => (b.left < a.left ? b : a))
  return { text: `${low.label} ${Math.round(low.left)}%`, fg: colorFor(low.left) }
}

export function ProfileSection({
  profile,
  section,
  dots,
  fillFrom,
  right,
  looked,
  collapsed,
  gapBefore = 0,
  today,
  days,
  scanning,
}: {
  profile: UsageProfile
  section: Section
  dots: string
  fillFrom: number | null
  right: number
  /** senu is looking at this profile: mark it and open its glance. */
  looked: boolean
  /** Only the title line (and any glance), so a glance fits a short terminal. */
  collapsed: boolean
  /** Blank rows above, from the list: none between two folded titles. */
  gapBefore?: number
  today: Today | null
  days: RangeDays
  scanning: boolean
}) {
  const { snapshot } = section
  const codex = profile.kind === "codex"
  const kindTitle = `${codex ? icons.codex : icons.claude} ${codex ? "Codex" : "Claude"} · `
  const title = kindTitle + profile.name
  const plan = snapshot?.planType ? ` · ${snapshot.planType}` : ""
  const lit = vision(section.landedAt)
  const glow = (fg: RGBA) => mix(fg, brand.gold, lit)
  // A folded title shows the profile's worst state where freshness would be.
  const fresh = (collapsed && statusOf(snapshot)) || freshness(section, dots, glow)
  // The marker gets its own cell so it never runs into the icon.
  const mark = looked ? "▸ " : "  "
  const pad = Math.max(
    2,
    right - mark.length - Bun.stringWidth(title) - plan.length - Bun.stringWidth(fresh.text),
  )
  const fill = tween(fillFrom, FILL_MS, easeOut)
  return (
    <box flexDirection="column" flexShrink={0} marginTop={gapBefore}>
      <Line>
        <span fg={brand.gold}>{mark}</span>
        <span fg={glow(codex ? colors.codex : colors.claude)} attributes={TextAttributes.BOLD}>
          {kindTitle}
        </span>
        <span
          fg={glow(codex ? colors.codex : colors.claude)}
          attributes={TextAttributes.BOLD | (looked ? TextAttributes.UNDERLINE : 0)}
        >
          {profile.name}
        </span>
        {plan ? <span fg={colors.muted}>{plan}</span> : null}
        {" ".repeat(pad)}
        <span fg={fresh.fg}>{fresh.text}</span>
      </Line>
      {collapsed ? null : <SectionBody section={section} fill={fill} right={right} />}
      {looked ? (
        <Glance
          snapshot={snapshot}
          today={today}
          days={days}
          scanning={scanning}
          dots={dots}
          right={right}
        />
      ) : null}
    </box>
  )
}

function SectionBody({
  section: { snapshot },
  fill,
  right,
}: {
  section: Section
  fill: number
  right: number
}) {
  return (
    <>
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
    </>
  )
}

/** Terminal rows a ProfileSection takes without its glance; one when collapsed. */
function sectionRows({ snapshot }: Section, collapsed = false): number {
  if (!snapshot || collapsed) return 1
  if (!snapshot.ok) return 2
  return 1 + snapshot.limits.length + (snapshot.spend ? 1 : 0) + (snapshot.banked ? 1 : 0)
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

function percent(part: number, whole: number): string {
  if (!(whole > 0)) return "—"
  const share = Math.round((100 * part) / whole)
  return share === 0 && part > 0 ? "<1%" : `${share}%`
}
const modelName = (m: string) => m.replace(/-\d{8}$/, "")
const kindColor = (kind: UsageProfile["kind"]) => (kind === "codex" ? colors.codex : colors.claude)
const kindTitle = (kind: UsageProfile["kind"]) =>
  kind === "codex" ? `${icons.codex} Codex` : `${icons.claude} Claude`
const PROFILE_KIND_WIDTH = Math.max(
  Bun.stringWidth(kindTitle("codex")),
  Bun.stringWidth(kindTitle("claude")),
)

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
            const kindLabel = kindTitle(profile.kind)
            const name = `${kindLabel}${" ".repeat(PROFILE_KIND_WIDTH - Bun.stringWidth(kindLabel))} · ${profile.name}`
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

type HintBinding = Binding & { desc?: string }

/** Esc first closes the glance, then quits. */
const quitKeys = (looking: boolean): HintBinding[] => [
  ...(looking ? [{ key: "escape", cmd: "look-none", desc: "esc close" }] : []),
  { key: "q", cmd: "quit", desc: "q quit" },
  { key: "shift+q", cmd: "quit" },
  ...(looking ? [] : [{ key: "escape", cmd: "quit" }]),
]
const limitsKeys: HintBinding[] = [
  { key: "up", cmd: "look-previous", desc: "↑/↓ look" },
  { key: "down", cmd: "look-next" },
  { key: "k", cmd: "look-previous" },
  { key: "shift+k", cmd: "look-previous" },
  { key: "j", cmd: "look-next" },
  { key: "shift+j", cmd: "look-next" },
  { key: "c", cmd: "show-cost", desc: "c cost" },
  { key: "shift+c", cmd: "show-cost" },
  { key: "t", cmd: "show-cost" },
  { key: "shift+t", cmd: "show-cost" },
  { key: "tab", cmd: "toggle-view" },
]
const rangeKeys: HintBinding[] = [
  { key: "left", cmd: "previous-range", desc: "←/→ range" },
  { key: "right", cmd: "next-range" },
  { key: "h", cmd: "previous-range" },
  { key: "shift+h", cmd: "previous-range" },
  { key: "l", cmd: "next-range" },
  { key: "shift+l", cmd: "next-range" },
  { key: "[", cmd: "previous-range" },
  { key: "]", cmd: "next-range" },
]
const costKeys: HintBinding[] = [
  ...rangeKeys,
  { key: "up", cmd: "toggle-breakdown", desc: "↑/↓ breakdown" },
  { key: "down", cmd: "toggle-breakdown" },
  { key: "j", cmd: "toggle-breakdown" },
  { key: "shift+j", cmd: "toggle-breakdown" },
  { key: "k", cmd: "toggle-breakdown" },
  { key: "shift+k", cmd: "toggle-breakdown" },
  { key: "c", cmd: "toggle-view", desc: "c limits" },
  { key: "shift+c", cmd: "toggle-view" },
  { key: "t", cmd: "toggle-view" },
  { key: "shift+t", cmd: "toggle-view" },
  { key: "tab", cmd: "toggle-view" },
]

/** The glance's chart takes the range keys while senu looks at a profile. */
const viewKeys = (view: View, looking: boolean) => [
  ...(view === "cost" ? costKeys : looking ? [...rangeKeys, ...limitsKeys] : limitsKeys),
  ...quitKeys(view === "limits" && looking),
]

export function UsagePopup({
  profiles,
  time,
  release = null,
}: {
  profiles: UsageProfile[]
  time: SceneTime
  /** A newer release to mention once senu settles. */
  release?: string | null
}) {
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
  const [gaze, setGaze] = useState<number | null>(null)
  /** senu's latest flight: from a screen point to a profile's perch, or back to the snag when null. */
  const [travel, setTravel] = useState<{ from: Point; to: number | null; at: number } | null>(null)
  const look = (step: 1 | -1) => {
    // The cycle runs through -1, where senu looks at no profile.
    setGaze((g) => {
      const slots = profiles.length + 1
      const at = (((g ?? -1) + 1 + step + slots) % slots) - 1
      return at === -1 ? null : at
    })
  }
  const activeKeys = useActiveKeys({ includeMetadata: true })
  useBindings(
    () => ({
      bindings: viewKeys(view, gaze != null),
      commands: [
        { name: "quit", run: () => renderer.destroy() },
        { name: "show-cost", run: () => setView("cost") },
        { name: "toggle-view", run: () => setView((v) => (v === "limits" ? "cost" : "limits")) },
        {
          name: "previous-range",
          run: () => setRange((r) => (r + RANGE_DAYS.length - 1) % RANGE_DAYS.length),
        },
        { name: "next-range", run: () => setRange((r) => (r + 1) % RANGE_DAYS.length) },
        { name: "look-previous", run: () => look(-1) },
        { name: "look-next", run: () => look(1) },
        { name: "look-none", run: () => setGaze(null) },
        {
          name: "toggle-breakdown",
          run: () => setBreakdown((b) => (b === "profile" ? "model" : "profile")),
        },
      ],
    }),
    [view, gaze != null, renderer, profiles.length],
  )

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

  const right = Math.min(cols, width) - 1
  const gutters = !noColor && view === "limits" && width >= SCENE_COLS + GUTTER
  const skyRows = noColor ? 0 : SCENE_ROWS + GAP_ROWS
  const listRows = height - FOOTER_ROWS
  const glanceStacked = glanceStacks(gutters ? right - GUTTER : right)
  // A glance that won't fit folds the other profiles to their titles, then the
  // sky gives way, then the looked-at profile folds its own limits behind its glance.
  const foldsAt = (fold: 0 | 1 | 2) => (i: number) => fold === 2 || (fold === 1 && i !== gaze)
  // Folded titles stack without a gap between them.
  const gapBefore = (folded: (i: number) => boolean, i: number) =>
    i > 0 && !(folded(i) && folded(i - 1)) ? 1 : 0
  const rowsWith = (fold: 0 | 1 | 2) => {
    const folded = foldsAt(fold)
    return (
      sections.reduce((n, s, i) => n + gapBefore(folded, i) + sectionRows(s, folded(i)), 0) +
      (gaze == null ? 0 : glanceRows(glanceStacked))
    )
  }
  const fits = (fold: 0 | 1 | 2, sky: boolean) => rowsWith(fold) <= listRows - (sky ? skyRows : 0)
  const fold: 0 | 1 | 2 =
    gaze == null || fits(0, true) ? 0 : fits(1, true) || fits(1, false) ? 1 : 2
  const skyless = fold > 0 && !fits(fold, true)
  const folded = foldsAt(fold)
  // senu leaves the snag only once landed, and only where the limits leave it a gutter.
  const perches = gutters && !skyless
  const sectionRight = perches ? right - GUTTER : right
  const sectionsTop = SCENE_ROWS + GAP_ROWS
  const topOf = (to: number) => {
    let top = sectionsTop
    for (let i = 0; i <= to; i++)
      top += gapBefore(folded, i) + (i < to ? sectionRows(sections[i]!, folded(i)) : 0)
    return top
  }
  const perchAt = (to: number | null): Point => {
    if (to == null) return snagAt(cols)
    // Stand beside the profile's limits, level with its last row.
    const last = topOf(to) + sectionRows(sections[to]!, folded(to)) - 1
    return { x: (width - GUTTER) * 2 + 5, y: last * 2 + 1 }
  }
  const hop: Hop | null = travel && { from: travel.from, to: perchAt(travel.to), at: travel.at }
  const goal = perches && flightDone(plan) ? gaze : null
  if ((travel?.to ?? null) !== goal)
    setTravel({ from: hop ? hopAt(hop, t) : snagAt(cols), to: goal, at: t })
  const away = hop != null && !(travel?.to == null && hopDone(hop, t))
  plan.away = away

  const fillFrom = sections.map(
    (s, i) =>
      s.landedAt ??
      (s.loadedAt == null ? null : Math.max(s.loadedAt, openedAt + STAGGER_MS * (i + 1))),
  )
  const tweening =
    fillFrom.some((from) => running(from, FILL_MS, t)) ||
    sections.some((s) => running(s.landedAt, VISION_MS, t)) ||
    (hop != null && hopRunning(hop, t))
  useTicker(flying || tweening ? FPS : busy ? 1000 / DOTS_MS : 0)

  const dots = reducedMotion ? "..." : ".".repeat((Math.floor((t - openedAt) / DOTS_MS) % 3) + 1)
  const settled = !skyless && !busy && flightDone(plan) && !(away && view === "limits")
  const announcing = settled && release != null
  const note = skyless
    ? ""
    : busy
      ? "senu is circling"
      : !flightDone(plan)
        ? "senu comes in to land"
        : !settled
          ? "senu looks closer"
          : announcing
            ? `v${release} is out · senu update`
            : "senu keeps watch"
  const hint = activeKeys
    .map((key) => key.bindingAttrs?.desc)
    .filter((desc): desc is string => typeof desc === "string")
    .join(" · ")
  const costRows = height - (noColor ? 0 : SCENE_ROWS + GAP_ROWS) - FOOTER_ROWS
  const gutter = new Canvas(GUTTER, Math.max(0, costRows + GAP_ROWS))
  if (hop && perches) {
    paintHop(gutter, hop, t, time, { x: width - GUTTER, y: SCENE_ROWS })
    // Perched, senu stands on a branch that reaches in from the right edge.
    if (gaze != null && travel?.to === gaze && !hopRunning(hop, t)) {
      const row = (hop.to.y - 1) / 2 + 1 - SCENE_ROWS
      // In the scene's pixel blocks: a half-cell limb under the talons, tapering to a tip.
      const bark = mix(brand.shadow, brand.sand, 0.3)
      gutter.put(1, row, "▝", bark)
      for (let x = 2; x < GUTTER - 1; x++) gutter.put(x, row, "▀", bark)
      gutter.put(GUTTER - 1, row, "█", bark)
    }
  }

  return (
    <box flexDirection="column" height={height} gap={1}>
      <box flexDirection="column" gap={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {noColor || skyless ? null : (
          <Sky
            plan={plan}
            width={width}
            overlay={hop && away ? (c) => paintHop(c, hop, t, time, { x: 0, y: 0 }) : undefined}
          />
        )}
        {view === "limits" ? (
          // The gutter reaches up over the gap row so senu never vanishes between the sky and the limits.
          <box flexDirection="row" flexShrink={1} marginTop={perches ? -GAP_ROWS : 0}>
            <box flexDirection="column" flexGrow={1} paddingTop={perches ? GAP_ROWS : 0}>
              {profiles.map((profile, i) => (
                <ProfileSection
                  key={`${profile.kind}:${profile.name}`}
                  gapBefore={gapBefore(folded, i)}
                  profile={profile}
                  section={sections[i]!}
                  dots={dots}
                  fillFrom={fillFrom[i]!}
                  right={sectionRight}
                  looked={gaze === i}
                  collapsed={folded(i)}
                  today={todays[i] ?? null}
                  days={RANGE_DAYS[range]!}
                  scanning={watchingToday[i] ?? false}
                />
              ))}
            </box>
            {perches ? <CanvasView canvas={gutter} /> : null}
          </box>
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
        {/* The note gives way before the keys do. */}
        {HEADER.length + hint.length + 2 + note.length <= right ? (
          <>
            {" ".repeat(right - HEADER.length - hint.length - note.length)}
            <span fg={busy ? brand.dusk : announcing ? brand.gold : brand.shadow}>{note}</span>
          </>
        ) : null}
      </Line>
    </box>
  )
}

export async function runUsagePopup(profiles: UsageProfile[], scene: UsageScene): Promise<number> {
  const { promise: closed, resolve } = Promise.withResolvers<void>()
  const renderer = await createCliRenderer({ useMouse: false, onDestroy: resolve })
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const gate = updateGate(renderer)
  createRoot(renderer).render(
    <KeymapProvider keymap={keymap}>
      <UpdateGate release={gate.release} onUpdate={gate.onUpdate}>
        <UsagePopup profiles={profiles} time={sceneTime(scene)} release={newerRelease()} />
      </UpdateGate>
    </KeymapProvider>,
  )
  await closed
  await gate.finish()
  // In-flight snapshot fetches can keep a closed tmux popup alive and leave it blank.
  process.exit(0)
}
