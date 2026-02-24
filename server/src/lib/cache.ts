import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

function scopePath(scope: string) {
  return path.join(process.cwd(), "cache", scope)
}

export function cacheKey(raw: string) {
  return createHash("sha256").update(raw).digest("hex")
}

export async function readJsonCache<T>(scope: string, key: string): Promise<T | null> {
  const filePath = path.join(scopePath(scope), `${key}.json`)
  try {
    const raw = await readFile(filePath, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function writeJsonCache(scope: string, key: string, value: unknown): Promise<void> {
  const dir = scopePath(scope)
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${key}.json`)
  await writeFile(filePath, JSON.stringify(value), "utf8")
}
