import { TextAttributes } from "@opentui/core"
import { type ReactNode } from "react"

import { Canvas, CanvasView } from "~/ui/canvas.tsx"
import { Line } from "~/ui/line.tsx"
import { brand, colors, mix, noColor } from "~/ui/theme.ts"

import { axis, barLayout, bucketDate, bucketLabel, stackedBars } from "./chart.ts"
import {
  BAR_WIDTH,
  INDENT,
  LABEL_WIDTH,
  clockSuffix,
  emptiesIn,
  formatClock,
  formatDuration,
  formatTokens,
  formatUntil,
  money,
} from "./format.ts"
import { RANGE_DAYS, RANGE_LABEL, type Bucket, type RangeDays, type Today } from "./today.ts"
import { nowSeconds, type Snapshot } from "./types.ts"

const CHART_ROWS = 2

type Pace =
  | { kind: "empty"; label: string; back: number | null }
  | { kind: "dry"; label: string; dry: number }
  /** `early` names a limit too new to project while every other one lasts. */
  | { kind: "lasts"; early: string | null }
  | { kind: "unknown"; label: string | null }

/**
 * The limit to watch: the empty one that locks you out longest, else the one
 * the burn rate so far locks out longest before its reset. "lasts" only when
 * every limit was projected or is too new to.
 */
function paceOf(snapshot: Snapshot): Pace {
  const t = nowSeconds()
  // A spend cap only covers usage past the plan, so it locks you out only with no plan limits.
  const capped = snapshot.spend?.reached && !snapshot.limits.length
  const empties = [
    ...(capped ? [{ label: "Spend", back: snapshot.spend!.resetsAt }] : []),
    ...snapshot.limits
      .filter((l) => l.left != null && l.left <= 0 && !(l.resetsAt != null && l.resetsAt <= t))
      .map((l) => ({ label: l.label, back: l.resetsAt })),
  ]
  // An unknown reset outlasts any known one.
  const later = (a: number | null, b: number | null) => a == null || (b != null && a > b)
  const locked = empties.reduce<(typeof empties)[number] | null>(
    (worst, e) => (!worst || later(e.back, worst.back) ? e : worst),
    null,
  )
  if (locked) return { kind: "empty", ...locked }

  let worst: { label: string; dry: number; short: number } | null = null
  let early: string | null = null
  let unknown: string | null = null
  for (const l of snapshot.limits) {
    // Untouched, or past a reset the cached snapshot predates: the window is fresh.
    if ((l.left != null && l.left >= 100) || (l.resetsAt != null && l.resetsAt <= t)) continue
    const remaining = l.resetsAt == null ? 0 : l.resetsAt - t
    const dry = remaining > 0 ? emptiesIn(l.left, l.resetsAt, l.windowMs) : null
    if (dry == null) {
      if (l.left != null && l.windowMs && remaining * 1000 > l.windowMs * 0.9) early ??= l.label
      else unknown ??= l.label
      continue
    }
    const short = remaining - dry
    if (short > 0 && (!worst || short > worst.short)) worst = { label: l.label, dry, short }
  }
  if (worst) return { kind: "dry", label: worst.label, dry: worst.dry }
  if (unknown != null || !snapshot.limits.length) return { kind: "unknown", label: unknown }
  return { kind: "lasts", early }
}

/** Where the glance's stats start: the column "resets" starts in the limit rows. */
const SIDE_COL = INDENT.length + LABEL_WIDTH + BAR_WIDTH + 7
/** Blank columns between the chart's right edge and the stats, so every range ends in one column. */
const CHART_GAP = 1
/** Stacked stats sit indented under the chart so they don't read as more axis. */
const STACK_COL = INDENT.length + LABEL_WIDTH + 2
/** Room the stats need beside the chart; narrower glances stack them under it. */
const SIDE_MIN = 30

/** Terminal rows the glance adds under its profile. */
export const glanceRows = (stacked: boolean) => 1 + CHART_ROWS + 1 + (stacked ? 3 : 0)

/** Whether a glance `right` columns wide stacks its stats under the chart. */
export const glanceStacks = (right: number) => right + 1 < SIDE_COL + SIDE_MIN

/** Bars on a fixed whole-column step: one column each for hours and days, three plus a gap for a week. */
const glanceWidth = (count: number) => (count <= 12 ? count * 4 - 1 : count)

/** Days since a Monday, in weeks, so alternate calendar weeks can be shaded. */
const weekOf = (label: string) =>
  Math.floor((bucketDate(label).getTime() - new Date(1970, 0, 5).getTime()) / (7 * 86_400_000))

/** Dollars as the glance prints them: whole above $100, where cents are noise. */
const usd = (v: number) => (v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : money(v))

function glanceChart(values: number[], buckets: Bucket[], days: RangeDays, peak: number): Canvas {
  const width = glanceWidth(values.length)
  const chart = stackedBars(
    values.map((v, i) => (i === peak ? { lower: 0, upper: v } : { lower: v, upper: 0 })),
    width,
    CHART_ROWS,
    brand.sand,
    brand.papyrus,
  )
  const { width: barCols, start } = barLayout(values.length, width)
  const shade = mix(brand.sand, brand.shadow, 0.2)
  buckets.forEach((b, i) => {
    for (let x = start(i); x < start(i) + barCols; x++) {
      // A dusk baseline marks a day with nothing, apart from a sand sliver of a little;
      // without colour the two would match, so nothing stays blank.
      if (!noColor && !chart.cells[CHART_ROWS - 1]![x])
        chart.put(x, CHART_ROWS - 1, "▁", brand.dusk)
      if (days !== 30 || i === peak || weekOf(b.label) % 2 === 0) continue
      for (const row of chart.cells) {
        const cell = row[x]
        if (cell?.fg === brand.sand) cell.fg = shade
        if (cell?.bg === brand.sand) cell.bg = shade
      }
    }
  })
  return chart
}

/** One stat line, its optional clock suffix dropped when it would not fit in `room` columns. */
function stat(text: ReactNode, used: number, clock: string | null, room: number): ReactNode {
  return (
    <>
      {text}
      {clock && used + clockSuffix(clock).length <= room ? (
        <span fg={colors.dim}>{clockSuffix(clock)}</span>
      ) : null}
    </>
  )
}

/**
 * What senu sees when it looks closer: a range strip with that range's total,
 * the profile's usage over the range as a small chart in the bar column, and
 * beside it the pace verdict and the average and peak.
 */
export function Glance({
  snapshot,
  today,
  days,
  scanning,
  dots,
  right,
}: {
  snapshot: Snapshot | null
  today: Today | null
  days: RangeDays
  scanning: boolean
  dots: string
  right: number
}) {
  const range = today?.ranges?.find((r) => r.days === days) ?? null
  const buckets = range?.buckets ?? []
  const cost = range?.costUsd ?? null
  // Usage the price table can't cost is still usage: chart its tokens.
  const byTokens = !!range && !(cost != null && cost > 0) && range.tokens > 0
  const values = buckets.map((b) => (byTokens ? b.tokens : b.costUsd))
  const amount = (v: number) => (byTokens ? `${formatTokens(v)} tok` : usd(v))
  const peak = values.reduce((p, v, i) => (v > (values[p] ?? 0) ? i : p), -1)
  const stacked = glanceStacks(right)
  const room = right + 1 - (stacked ? STACK_COL : SIDE_COL)
  const stripCols =
    INDENT.length - 1 + RANGE_DAYS.reduce((n, d) => n + RANGE_LABEL[d].length + 2, 0)

  const pace = snapshot?.ok ? paceOf(snapshot) : null
  const verdict = TextAttributes.BOLD
  let paceLine: ReactNode
  if (!snapshot) paceLine = <span fg={colors.dim}>{`fetching limits${dots}`}</span>
  else if (!snapshot.ok) paceLine = <span fg={colors.dim}>limits unavailable</span>
  else if (pace?.kind === "empty") {
    const back = pace.back == null ? "" : ` · back in ${formatUntil(pace.back)}`
    paceLine = stat(
      <>
        <span fg={colors.bad} attributes={verdict}>{`${pace.label} empty`}</span>
        <span fg={colors.dim}>{back}</span>
      </>,
      `${pace.label} empty${back}`.length,
      pace.back == null ? null : formatClock(pace.back),
      room,
    )
  } else if (pace?.kind === "dry") {
    const text = `${pace.label} dry in ~${formatDuration(pace.dry)}`
    paceLine = stat(
      <span fg={colors.warn} attributes={verdict}>
        {text}
      </span>,
      text.length,
      formatClock(nowSeconds() + pace.dry),
      room,
    )
  } else if (pace?.kind === "lasts")
    paceLine =
      pace.early == null ? (
        <span fg={colors.good} attributes={verdict}>
          holds to reset
        </span>
      ) : (
        <>
          <span fg={colors.good} attributes={verdict}>
            holds so far
          </span>
          {/* The tail shortens, then goes, before it runs past the stats' room. */}
          <span fg={colors.dim}>
            {[` · ${pace.early} too new to read`, ` · ${pace.early} too new`, ""].find(
              (tail) => "holds so far".length + tail.length <= room,
            )}
          </span>
        </>
      )
  else if (pace?.kind === "unknown")
    paceLine = (
      <span fg={colors.dim}>
        {pace.label == null ? "pace unknown" : `${pace.label} pace unknown`}
      </span>
    )

  const totalText = byTokens
    ? `${formatTokens(range?.tokens ?? 0)} tok unpriced`
    : `${range?.unpricedTokens ? "≥" : ""}${usd(cost ?? 0)} at API rates`
  // The scanning note gives way before the total runs past its room.
  const scanNote = scanning && totalText.length + " · scanning...".length <= room
  // An empty range already says so in the chart; the total adds nothing.
  const totalLine =
    !range || peak < 0 ? null : (
      <>
        {byTokens ? (
          <>
            <span fg={brand.papyrus}>{`${formatTokens(range.tokens)} tok`}</span>
            <span fg={colors.dim}> unpriced</span>
          </>
        ) : (
          <>
            {/* Some tokens went uncosted, so the true figure is at least this. */}
            <span fg={brand.papyrus}>{(range.unpricedTokens ? "≥" : "") + usd(cost ?? 0)}</span>
            <span fg={colors.dim}> at API rates</span>
          </>
        )}
        {scanNote ? <span fg={colors.dim}>{` · scanning${dots}`}</span> : null}
      </>
    )

  const per = days === 1 ? new Date().getHours() + 1 : days
  const total = byTokens ? (range?.tokens ?? 0) : (cost ?? 0)
  const avgText = `avg ${amount(total / per)}/${days === 1 ? "h" : "day"}`
  const peakAt = buckets[peak]
  const peakText = peakAt ? ` ${amount(values[peak]!)}` : ""
  const peakDate = peakAt ? ` ${bucketLabel(peakAt.label, days)}` : ""
  // The peak's date goes first when room runs short, then the peak itself.
  const fits = (n: number) => n <= room
  const showPeak = !!peakAt && fits(avgText.length + 7 + peakText.length)
  const showDate = showPeak && fits(avgText.length + 7 + peakText.length + peakDate.length)
  const avgLine =
    peak < 0 ? null : (
      <>
        <span fg={colors.dim}>{avgText}</span>
        {showPeak ? (
          <>
            <span fg={colors.dim}>{" · "}</span>
            {/* "peak" takes its bar's colour as a legend key; the figure stays quiet. */}
            <span fg={brand.papyrus}>peak</span>
            <span fg={colors.dim}>{peakText + (showDate ? peakDate : "")}</span>
          </>
        ) : null}
      </>
    )

  const chartCols = glanceWidth(buckets.length || 24)
  const chart =
    peak >= 0 ? (
      <>
        <CanvasView canvas={glanceChart(values, buckets, days, peak)} />
        <Line fg={colors.dim}>{axis(buckets, days, chartCols)}</Line>
      </>
    ) : (
      // Empty ground keeps the chart's shape: the message above a bare baseline.
      <>
        <Line fg={colors.dim}>
          {range ? "no usage in this range" : scanning ? `scanning${dots}` : "no transcripts"}
        </Line>
        <Line fg={brand.dusk}>{noColor ? " " : "▁".repeat(chartCols)}</Line>
        <Line> </Line>
      </>
    )
  const lines = (nodes: ReactNode[]) =>
    nodes.map((s, i) => (
      // oxlint-disable-next-line react/no-array-index-key -- rows are positional
      <Line key={i}>{s ?? " "}</Line>
    ))

  // Ranges end at one edge, with today nearest the stats; 30 days span the bar column.
  const chartBox = (
    <box flexDirection="row" flexShrink={0} width={SIDE_COL}>
      <box width={SIDE_COL - CHART_GAP - chartCols} flexShrink={0} />
      <box flexDirection="column" flexShrink={0}>
        {chart}
      </box>
    </box>
  )

  // The strip heads the glance and carries its range's total; pace and the
  // average sit beside the bars, leaving the axis row to the axis.
  return (
    <>
      <Line>
        {INDENT.slice(1)}
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
        {/* The rule leads to the range's total, so it goes when there is none. */}
        {stacked || !totalLine ? null : (
          <>
            <span fg={colors.rule}>{"─".repeat(SIDE_COL - stripCols - 1) + " "}</span>
            {totalLine}
          </>
        )}
      </Line>
      <box flexDirection="row" flexShrink={0}>
        {chartBox}
        {stacked ? null : (
          <box flexDirection="column" flexShrink={0}>
            {lines([paceLine, avgLine])}
          </box>
        )}
      </box>
      {stacked ? (
        <box flexDirection="row" flexShrink={0}>
          <box width={STACK_COL} flexShrink={0} />
          <box flexDirection="column" flexShrink={0}>
            {lines([paceLine, totalLine, avgLine])}
          </box>
        </box>
      ) : null}
    </>
  )
}
