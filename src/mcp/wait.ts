import type { Config } from "~/config.ts"
import { allowedProfiles } from "~/privacy.ts"
import { profileKey } from "~/profiles.ts"

import { address, sender } from "./send.ts"
import { MessageStore } from "./store.ts"

export async function waitForReply(
  config: Config,
  messageId: string,
  timeoutMs?: number,
  signal?: AbortSignal,
) {
  const from = await sender(config)
  const profiles = allowedProfiles(config).map(profileKey)
  const store = new MessageStore()
  try {
    return await store.waitForReply(messageId, address(from), profiles, timeoutMs, signal)
  } finally {
    store.close()
  }
}
