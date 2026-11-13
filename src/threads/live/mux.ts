import type { Profile, ThreadsConfig } from "~/config.ts"
import type { Pane } from "~/detect/panes.ts"

import type { Live } from "../entries.ts"
import type { Launch } from "../resume.ts"
import type { Collected, PaneRow } from "./collect.ts"
import { inRex, rexMux } from "./rex.ts"
import { tmuxMux } from "./tmux.ts"

/** What a multiplexer can see right now. */
export interface Seen {
  panes: Pick<Pane, "id" | "windowId" | "windowIndex" | "session" | "cwd">[]
  rows: PaneRow[]
  /** Running threads' panes, by `threadKey` */
  paneByThread: Map<string, string>
}

/** What senu needs from a multiplexer. Actions resolve to why they failed, or null. */
export interface Mux {
  /** Keeps what it learns between polls, so the picker holds one. */
  collector(): { collect(): Promise<Collected> }
  seen(profiles: Profile[]): Promise<Seen>
  jump(live: Live, opts: Pick<ThreadsConfig, "raiseGhosttyTab">): Promise<string | null>
  kill(paneId: string): Promise<boolean>
  /** Whether a resumed thread gets its own window rather than this terminal. */
  resumesInWindow(mode: ThreadsConfig["resume"]): Promise<boolean>
  openWindow(launch: Launch): Promise<string | null>
}

export const mux = (): Mux => (inRex() ? rexMux : tmuxMux)
