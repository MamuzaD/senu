import { TextAttributes } from "@opentui/core"
import { type Binding } from "@opentui/keymap"
import { useBindings } from "@opentui/keymap/react"
import { useState } from "react"

import { Line } from "~/ui/line.tsx"
import { brand, colors, states } from "~/ui/theme.ts"

import { version } from "../../package.json"
import { installCommand } from "./command.ts"
import { REPO } from "./release.ts"

/** "skip" asks again next time; "dismiss" waits for the release after this one. */
export type UpdateChoice = "update" | "skip" | "dismiss"

const CHOICES: UpdateChoice[] = ["update", "skip", "dismiss"]

const keys: Binding[] = [
  { key: "j", cmd: "next" },
  { key: "k", cmd: "previous" },
  { key: "down", cmd: "next" },
  { key: "up", cmd: "previous" },
  { key: "tab", cmd: "next" },
  { key: "1", cmd: "update" },
  { key: "2", cmd: "skip" },
  { key: "3", cmd: "dismiss" },
  { key: "return", cmd: "choose" },
  { key: "escape", cmd: "skip" },
  { key: "q", cmd: "skip" },
]

const DIM = TextAttributes.DIM

/** Codex-style "update available" picker, shown before a popup opens. */
export function UpdatePrompt({
  latest,
  onChoose,
}: {
  latest: string
  onChoose: (choice: UpdateChoice) => void
}) {
  const [cursor, setCursor] = useState(0)
  const move = (by: number) => setCursor((i) => (i + by + CHOICES.length) % CHOICES.length)

  useBindings(
    () => ({
      bindings: keys,
      commands: [
        { name: "next", run: () => move(1) },
        { name: "previous", run: () => move(-1) },
        { name: "update", run: () => onChoose("update") },
        { name: "skip", run: () => onChoose("skip") },
        { name: "dismiss", run: () => onChoose("dismiss") },
        { name: "choose", run: () => onChoose(CHOICES[cursor]!) },
      ],
    }),
    [cursor, onChoose],
  )

  const option = (i: number, label: string, detail?: string) => {
    const on = cursor === i
    return (
      <box flexDirection="column">
        <Line>
          <span fg={on ? brand.gold : colors.dim}>{on ? "› " : "  "}</span>
          <span fg={on ? brand.gold : brand.papyrus} attributes={on ? TextAttributes.BOLD : 0}>
            {`${i + 1}. ${label}`}
          </span>
        </Line>
        {detail ? (
          <box paddingLeft={5}>
            <text fg={colors.muted} attributes={DIM}>
              {detail}
            </text>
          </box>
        ) : null}
      </box>
    )
  }

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <box flexDirection="column">
        <Line>
          <span fg={brand.gold} attributes={TextAttributes.BOLD}>
            update available
          </span>
          <span fg={colors.dim}>{" · "}</span>
          <span fg={brand.dusk}>{version}</span>
          <span fg={brand.papyrus}>{" → "}</span>
          <span fg={states.done.fg} attributes={TextAttributes.BOLD}>
            {latest}
          </span>
        </Line>
        <Line>
          <span fg={colors.muted} attributes={DIM}>
            {"release notes: "}
          </span>
          <span fg={colors.muted}>{`github.com/${REPO}/releases/tag/v${latest}`}</span>
        </Line>
      </box>
      <box flexDirection="column">
        {option(0, "update now", `runs ${installCommand(`v${latest}`)}`)}
        {option(1, "skip")}
        {option(2, "skip until next version")}
      </box>
      <Line>
        <span fg={colors.muted} attributes={DIM}>
          ↑/↓ move · ⏎ choose · esc skip
        </span>
      </Line>
    </box>
  )
}
