import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"
import { expandHome, stateDir } from "../paths.ts"
import type { SoundKind } from "./state.ts"

export const SYSTEM_SOUNDS: Record<SoundKind, string> = {
  done: "/System/Library/Sounds/Glass.aiff",
  request: "/System/Library/Sounds/Funk.aiff",
}

/** Chooses an existing custom file, then the fallback; returns null if neither exists. */
export function pickSound(custom: string, fallback: string, exists: (p: string) => boolean = existsSync): string | null {
  const path = custom.trim() ? expandHome(custom.trim()) : ""
  for (const p of [path, fallback]) if (p && exists(p)) return p
  return null
}

export function defaultSoundFile(kind: SoundKind, dir = join(stateDir, "sounds")): string {
  const path = join(dir, `${kind}.wav`)
  if (existsSync(path)) return path

  const sampleRate = 22_050
  const samples = Math.floor(sampleRate * 0.22)
  const dataSize = samples * 2
  const wav = Buffer.alloc(44 + dataSize)
  wav.write("RIFF", 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20) // PCM format
  wav.writeUInt16LE(1, 22) // Mono channel count
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36)
  wav.writeUInt32LE(dataSize, 40)
  const notes = kind === "done" ? [660, 880] : [880, 660]
  for (let i = 0; i < samples; i++) {
    const progress = i / samples
    const envelope = Math.min(1, i / 180) * Math.min(1, (samples - i) / 1200)
    const frequency = notes[progress < 0.5 ? 0 : 1]!
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * envelope * 9000), 44 + i * 2)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, wav)
  return path
}

export function resolveSound(kind: SoundKind, custom: string): string | null {
  const chosen = pickSound(custom, process.platform === "darwin" ? SYSTEM_SOUNDS[kind] : "")
  if (chosen) return chosen
  try {
    return defaultSoundFile(kind)
  } catch {
    return null
  }
}

export function isWsl(): boolean {
  if (process.platform !== "linux") return false
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"))
  } catch {
    return false
  }
}

function windowsPath(path: string): string | null {
  try {
    const result = Bun.spawnSync(["wslpath", "-w", path])
    return result.exitCode === 0 ? result.stdout.toString().trim() || null : null
  } catch {
    return null
  }
}

export const powershellString = (value: string) => `'${value.replaceAll("'", "''")}'`

const MEDIA_PLAY = "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]$env:SENU_SOUND_FILE); $p.Play(); $i = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $i -lt 50) { Start-Sleep -Milliseconds 100; $i++ }; if (-not $p.NaturalDuration.HasTimeSpan) { throw 'Cannot play sound' }; Start-Sleep -Milliseconds ([math]::Ceiling($p.NaturalDuration.TimeSpan.TotalMilliseconds)); $p.Close()"

export function playerCommand(path: string, platform = process.platform, which: (name: string) => string | null = Bun.which, wsl = isWsl()): string[] | null {
  if (platform === "darwin") return which("afplay") ? ["afplay", path] : null
  if (platform === "win32") {
    if (!which("powershell.exe")) return null
    const script = extname(path).toLowerCase() === ".wav"
      ? "$ErrorActionPreference = 'Stop'; (New-Object System.Media.SoundPlayer $env:SENU_SOUND_FILE).PlaySync()"
      : MEDIA_PLAY
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]
  }
  if (platform === "linux") {
    if (wsl && which("powershell.exe") && which("wslpath")) {
      return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", MEDIA_PLAY]
    }
    if (extname(path).toLowerCase() === ".wav") {
      if (which("pw-play")) return ["pw-play", path]
      if (which("paplay")) return ["paplay", path]
      if (which("aplay")) return ["aplay", "-q", path]
    }
    if (which("ffplay")) return ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path]
    if (which("mpv")) return ["mpv", "--no-video", "--really-quiet", path]
  }
  return null
}

export function playbackCommand(
  path: string,
  platform = process.platform,
  which: (name: string) => string | null = Bun.which,
  wsl = isWsl(),
  toWindowsPath: (path: string) => string | null = windowsPath,
): string[] | null {
  let command = playerCommand(path, platform, which, wsl)
  if (platform === "linux" && wsl && command?.[0] === "powershell.exe") {
    const file = toWindowsPath(path)
    if (file) command[4] = command[4]!.replace("$env:SENU_SOUND_FILE", powershellString(file))
    else command = playerCommand(path, platform, which, false)
  }
  return command
}

/** Starts playback without waiting for the sound to finish. */
export function play(path: string): Bun.Subprocess | null {
  const command = playbackCommand(path)
  if (!command) return null
  try {
    const proc = Bun.spawn(command, {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.platform === "win32" ? { ...process.env, SENU_SOUND_FILE: path } : undefined,
    })
    proc.unref()
    return proc
  } catch {
    return null
  }
}
