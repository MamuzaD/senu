/** herdr's ManifestVersion order: numeric by segment, missing segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(BigInt)
  const y = b.split(".").map(BigInt)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0n) - (y[i] ?? 0n)
    if (d !== 0n) return d > 0n ? 1 : -1
  }
  return 0
}
