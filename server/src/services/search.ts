import { cacheKey, readJsonCache, writeJsonCache } from "../lib/cache"
import type { SearchResult } from "../types"

function parseBBox(raw: string[]): [number, number, number, number] | null {
  if (raw.length !== 4) return null
  const [south, north, west, east] = raw.map(Number)
  if ([south, north, west, east].some((v) => Number.isNaN(v))) return null
  return [west, south, east, north]
}

export async function searchNominatim(query: string): Promise<SearchResult[]> {
  const normalized = query.trim().toLowerCase()
  const key = cacheKey(`search:wa-v1:${normalized}`)
  const cached = await readJsonCache<SearchResult[]>("search", key)
  if (cached) return cached

  const url = new URL("https://nominatim.openstreetmap.org/search")
  url.searchParams.set("format", "jsonv2")
  url.searchParams.set("limit", "10")
  url.searchParams.set("countrycodes", "us")
  url.searchParams.set("viewbox", "-124.9,49.1,-116.8,45.4")
  url.searchParams.set("bounded", "0")
  url.searchParams.set("addressdetails", "0")
  url.searchParams.set("q", query)

  const response = await fetch(url, {
    headers: {
      "User-Agent": "emp-hackfest/1.0 (+https://localhost)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Nominatim error ${response.status}: ${text.slice(0, 200)}`)
  }

  const raw = (await response.json()) as Array<{
    display_name: string
    lat: string
    lon: string
    boundingbox: string[]
    type?: string
  }>

  const results: SearchResult[] = raw
    .map((item) => {
      const bbox = parseBBox(item.boundingbox)
      const lat = Number(item.lat)
      const lon = Number(item.lon)
      if (!bbox || Number.isNaN(lat) || Number.isNaN(lon)) return null
      return {
        display_name: item.display_name,
        lat,
        lon,
        bbox,
        type: item.type ?? "location",
      }
    })
    .filter((item): item is SearchResult => item !== null)

  await writeJsonCache("search", key, results)
  return results
}
