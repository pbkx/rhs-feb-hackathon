export function reportDisplayId(reportId: string) {
  let hash = 2166136261
  for (let i = 0; i < reportId.length; i += 1) {
    hash ^= reportId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const numeric = (hash >>> 0) % 1_000_000
  return numeric.toString().padStart(6, "0")
}

