import { TextAttributes, createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useState, type ReactNode } from "react"
import type { UsageProfile } from "../config.ts"
import { Eagle } from "../ui/eagle.tsx"
import { Line } from "../ui/line.tsx"
import { colors, icons } from "../ui/theme.ts"
import { getSnapshot, readCache } from "./cache.ts"
import { BAR_WIDTH, LABEL_WIDTH, bar, colorFor, formatDuration, formatUntil } from "./format.ts"
import { errorSnapshot, nowSeconds, type Banked, type Snapshot, type Spend } from "./types.ts"

/** Older than this, a section says it's refreshing and watches for a newer snapshot. */
const STALE_NOTICE_SECONDS = 10 * 60
const POLL_MS = 1000
const MAX_POLL_SECONDS = 20

interface Section {
  snapshot: Snapshot | null
  refreshing: boolean
  justUpdated: boolean
}

const INDENT = "  "

function Row({ label, left, resetsAt, children }: {
  label: string
  left: number | null
  resetsAt: number | null
  children?: ReactNode
}) {
  const color = colorFor(left)
  const pct = left == null ? "n/a" : `${Math.round(left)}%`
  const reset = formatUntil(resetsAt)
  return (
    <Line>
      {INDENT + label.padEnd(LABEL_WIDTH) + " "}
      <span fg={color}>{bar(left)}</span>
      <span fg={color}>{" " + pct.padStart(4)}</span>
      {children}
      {reset ? <span fg={colors.muted}>{`  resets ${reset}`}</span> : null}
    </Line>
  )
}

function SpendRow({ spend }: { spend: Spend }) {
  const color = spend.reached ? colors.bad : colorFor(spend.left)
  return (
    <Row label="Spend" left={spend.left} resetsAt={spend.resetsAt}>
      <span fg={color}>{`  $${spend.used.toFixed(2)}`}</span>
      <span fg={colors.muted}>{`/$${spend.limit.toFixed(0)}`}</span>
      {spend.reached ? <span fg={colors.bad}> cap reached</span> : null}
    </Row>
  )
}

function BankedRows({ banked }: { banked: Banked }) {
  const label = INDENT + "Banked".padEnd(LABEL_WIDTH) + " "
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
  return (
    <>
      <Line>
        {label}
        <span fg={colors.good}>{"●".repeat(banked.available)}</span>
        <span attributes={TextAttributes.BOLD}>{` ${banked.available}`}</span>
        <span fg={colors.muted}>{banked.available === 1 ? " reset" : " resets"}</span>
        {soonest != null ? <span fg={colors.muted}>{`  expires ${formatUntil(soonest)}`}</span> : null}
      </Line>
      {titles.map((title) => (
        <Line key={title} fg={colors.muted}>
          {INDENT + " ".repeat(LABEL_WIDTH + 1) + title}
        </Line>
      ))}
    </>
  )
}

function Freshness({ section, dots }: { section: Section; dots: string }) {
  const { snapshot } = section
  if (!snapshot) return <Line fg={colors.muted}>{`fetching${dots}`}</Line>
  if (section.justUpdated) return <Line fg={colors.good}>✓ now updated</Line>
  const age = nowSeconds() - snapshot.updatedAt
  if (section.refreshing) return <Line fg={colors.warn}>{`${formatDuration(age)} old · refreshing${dots}`}</Line>
  const when = age < 60 ? "just now" : `${formatDuration(age)} ago`
  return <Line fg={colors.muted}>{`✓ updated ${when}`}</Line>
}

function ProfileSection({ profile, section, dots }: { profile: UsageProfile; section: Section; dots: string }) {
  const { snapshot } = section
  const codex = profile.kind === "codex"
  const title = `${codex ? icons.codex : icons.claude} ${codex ? "Codex" : "Claude"} · ${profile.name}`
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line>
        <span fg={codex ? colors.codex : colors.claude} attributes={TextAttributes.BOLD}>{title}</span>
        {snapshot?.planType ? <span fg={colors.muted}>{` · ${snapshot.planType}`}</span> : null}
      </Line>
      <Line fg={colors.rule}>{"─".repeat(LABEL_WIDTH + BAR_WIDTH + 8)}</Line>
      <Freshness section={section} dots={dots} />
      {snapshot && !snapshot.ok ? <Line fg={colors.bad}>{`${INDENT}✗ ${snapshot.error ?? "unknown"}`}</Line> : null}
      {snapshot?.ok
        ? snapshot.limits.map((l) => <Row key={l.label} label={l.label} left={l.left} resetsAt={l.resetsAt} />)
        : null}
      {snapshot?.ok && snapshot.spend ? <SpendRow spend={snapshot.spend} /> : null}
      {snapshot?.ok && snapshot.banked ? <BankedRows banked={snapshot.banked} /> : null}
    </box>
  )
}

function UsagePopup({ profiles }: { profiles: UsageProfile[] }) {
  const renderer = useRenderer()
  const [sections, setSections] = useState<Section[]>(() =>
    profiles.map(() => ({ snapshot: null, refreshing: false, justUpdated: false })),
  )
  const [tick, setTick] = useState(0)
  const [startedAt] = useState(() => Date.now())

  const update = (i: number, patch: Partial<Section>) =>
    setSections((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  useEffect(() => {
    profiles.forEach(async (profile, i) => {
      const snapshot = await getSnapshot(profile).catch((err) =>
        errorSnapshot(err instanceof Error ? err.message : String(err)),
      )
      update(i, { snapshot, refreshing: nowSeconds() - snapshot.updatedAt > STALE_NOTICE_SECONDS })
    })
  }, [])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), POLL_MS)
    return () => clearInterval(id)
  }, [])

  // watch refreshing sections for the background refresh to land
  useEffect(() => {
    const watchedOut = Date.now() - startedAt >= MAX_POLL_SECONDS * 1000
    sections.forEach((section, i) => {
      if (!section.refreshing || !section.snapshot) return
      const fresh = readCache(profiles[i]!)?.snapshot
      if (fresh && fresh.updatedAt > section.snapshot.updatedAt) {
        update(i, { snapshot: fresh, refreshing: false, justUpdated: true })
      } else if (watchedOut) {
        update(i, { refreshing: false })
      }
    })
  }, [tick])

  useKeyboard(() => renderer.destroy())

  const busy = sections.some((s) => !s.snapshot || s.refreshing)
  const dots = ".".repeat((tick % 3) + 1)

  return (
    <box flexDirection="column" paddingLeft={2} gap={1}>
      <Eagle circling={busy} />
      {profiles.map((profile, i) => (
        <ProfileSection key={`${profile.kind}:${profile.name}`} profile={profile} section={sections[i]!} dots={dots} />
      ))}
      <Line fg={colors.muted} attributes={TextAttributes.DIM}>
        press any key to close
      </Line>
    </box>
  )
}

export async function runUsagePopup(profiles: UsageProfile[]): Promise<number> {
  const { promise: closed, resolve } = Promise.withResolvers<void>()
  const renderer = await createCliRenderer({ useMouse: false, onDestroy: resolve })
  createRoot(renderer).render(<UsagePopup profiles={profiles} />)
  await closed
  // exit now rather than waiting on in-flight fetches, or a tmux popup stays open blank
  process.exit(0)
}
