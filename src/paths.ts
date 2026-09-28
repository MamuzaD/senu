import { homedir } from "node:os"
import { join } from "node:path"

export const home = homedir()

export function expandHome(path: string): string {
  if (path === "~") return home
  if (path.startsWith("~/")) return join(home, path.slice(2))
  return path
}

export const configDir = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "senu")
export const configPath = join(configDir, "config.toml")
export const cacheDir = join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "senu")
export const stateDir = join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "senu")

// Compiled binaries run their entrypoint from Bun's virtual /$bunfs filesystem.
export const compiled = Bun.main.startsWith("/$bunfs/")

export function selfCommand(): string[] {
  return compiled ? [process.execPath] : [process.execPath, Bun.main]
}
