import { cacheKey, readJsonCache, writeJsonCache } from "../lib/cache"
import type { BBox } from "../types"

const TILED_FALLBACK_AREA_THRESHOLD = 0.03
const FULL_QUERY_TIMEOUT_MS = 90_000
const TILED_QUERY_TIMEOUT_MS = 60_000
const MAX_TILE_DEPTH = 2

export interface OverpassNode {
  type: "node"
  id: number
  lat: number
  lon: number
  tags?: Record<string, string>
}

export interface OverpassWay {
  type: "way"
  id: number
  nodes: number[]
  tags?: Record<string, string>
}

export type OverpassElement = OverpassNode | OverpassWay | { type: string; id: number }

export interface OverpassResponse {
  elements: OverpassElement[]
}

interface FetchMode {
  cache_scope: string
  query_version: string
  query_builder: (bbox: BBox) => string
}

export function overpassQueryVersion() {
  return "access-v1"
}

export function overpassPoisQueryVersion() {
  return "pois-v1"
}

function bboxAreaDegrees(bbox: BBox) {
  const [minLon, minLat, maxLon, maxLat] = bbox
  return Math.abs(maxLon - minLon) * Math.abs(maxLat - minLat)
}

function splitBBox4(bbox: BBox): BBox[] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const midLon = (minLon + maxLon) / 2
  const midLat = (minLat + maxLat) / 2
  return [
    [minLon, minLat, midLon, midLat],
    [midLon, minLat, maxLon, midLat],
    [minLon, midLat, midLon, maxLat],
    [midLon, midLat, maxLon, maxLat],
  ]
}

function mergeResponses(responses: OverpassResponse[]): OverpassResponse {
  const byId = new Map<string, OverpassElement>()
  for (const response of responses) {
    for (const element of response.elements) {
      byId.set(`${element.type}/${element.id}`, element)
    }
  }
  return { elements: [...byId.values()] }
}

function bboxToOverpass(bbox: BBox) {
  const [minLon, minLat, maxLon, maxLat] = bbox
  return `${minLat},${minLon},${maxLat},${maxLon}`
}

export function buildPoisOverpassQuery(bbox: BBox) {
  const bboxOverpass = bboxToOverpass(bbox)
  return `
[out:json][timeout:90];
(
  node["amenity"~"^(hospital|clinic|doctors|pharmacy)$"](${bboxOverpass});
  way["amenity"~"^(hospital|clinic|doctors|pharmacy)$"](${bboxOverpass});
  node["healthcare"](${bboxOverpass});
  way["healthcare"](${bboxOverpass});
  node["emergency"="ambulance_station"](${bboxOverpass});

  node["amenity"="toilets"](${bboxOverpass});
  way["amenity"="toilets"](${bboxOverpass});
  node["amenity"="drinking_water"](${bboxOverpass});
  way["amenity"="drinking_water"](${bboxOverpass});
  node["amenity"="bench"](${bboxOverpass});
  way["amenity"="bench"](${bboxOverpass});

  node["wheelchair"](${bboxOverpass});
  way["wheelchair"](${bboxOverpass});
);
(._;>;);
out body;
`.trim()
}

export function buildAccessOverpassQuery(bbox: BBox) {
  const bboxOverpass = bboxToOverpass(bbox)
  return `
[out:json][timeout:90];
(
  way["highway"~"^(footway|path|pedestrian|steps)$"](${bboxOverpass});
  way["highway"="living_street"](${bboxOverpass});
  way["highway"="service"]["service"="alley"](${bboxOverpass});

  node["barrier"="kerb"](${bboxOverpass});
  node["highway"="elevator"](${bboxOverpass});
  way["highway"="elevator"](${bboxOverpass});

  node["amenity"~"^(hospital|clinic|doctors|pharmacy)$"](${bboxOverpass});
  way["amenity"~"^(hospital|clinic|doctors|pharmacy)$"](${bboxOverpass});
  node["healthcare"](${bboxOverpass});
  way["healthcare"](${bboxOverpass});
  node["emergency"="ambulance_station"](${bboxOverpass});

  node["amenity"="toilets"](${bboxOverpass});
  way["amenity"="toilets"](${bboxOverpass});
  node["amenity"="drinking_water"](${bboxOverpass});
  way["amenity"="drinking_water"](${bboxOverpass});
  node["amenity"="bench"](${bboxOverpass});
  way["amenity"="bench"](${bboxOverpass});

  node["wheelchair"](${bboxOverpass});
  way["wheelchair"](${bboxOverpass});
);
(._;>;);
out body;
`.trim()
}

async function fetchOverpassQuery(query: string, timeoutMs: number): Promise<OverpassResponse> {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ]

  let lastError: unknown = null
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "User-Agent": "emp-hackfest/1.0 (+https://localhost)",
        },
        body: query,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Overpass error ${response.status}: ${text.slice(0, 300)}`)
      }
      return (await response.json()) as OverpassResponse
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to fetch from Overpass")
}

async function fetchOverpassRecursive(
  bbox: BBox,
  depth: number,
  mode: FetchMode
): Promise<OverpassResponse> {
  const query = mode.query_builder(bbox)
  const key = cacheKey(
    `overpass:${mode.cache_scope}:${mode.query_version}:depth:${depth}:${JSON.stringify(bbox)}:${query}`
  )
  const cached = await readJsonCache<OverpassResponse>("overpass", key)
  if (cached) return cached

  try {
    const timeoutMs = depth === 0 ? FULL_QUERY_TIMEOUT_MS : TILED_QUERY_TIMEOUT_MS
    const json = await fetchOverpassQuery(query, timeoutMs)
    await writeJsonCache("overpass", key, json)
    return json
  } catch (error) {
    const canTileFallback =
      depth < MAX_TILE_DEPTH &&
      bboxAreaDegrees(bbox) >= TILED_FALLBACK_AREA_THRESHOLD / 4
    if (!canTileFallback) {
      throw error
    }

    const responses: OverpassResponse[] = []
    for (const tile of splitBBox4(bbox)) {
      responses.push(await fetchOverpassRecursive(tile, depth + 1, mode))
    }
    const merged = mergeResponses(responses)
    await writeJsonCache("overpass", key, merged)
    return merged
  }
}

async function fetchOverpassMode(bbox: BBox, mode: FetchMode): Promise<OverpassResponse> {
  const finalKey = cacheKey(
    `overpass:${mode.cache_scope}:${mode.query_version}:final:${JSON.stringify(bbox)}`
  )
  const cached = await readJsonCache<OverpassResponse>("overpass", finalKey)
  if (cached) return cached

  const response = await fetchOverpassRecursive(bbox, 0, mode)
  await writeJsonCache("overpass", finalKey, response)
  return response
}

export async function fetchOverpassRaw(bbox: BBox): Promise<OverpassResponse> {
  return fetchOverpassMode(bbox, {
    cache_scope: "access",
    query_version: overpassQueryVersion(),
    query_builder: buildAccessOverpassQuery,
  })
}

export async function fetchOverpassPois(bbox: BBox): Promise<OverpassResponse> {
  return fetchOverpassMode(bbox, {
    cache_scope: "pois",
    query_version: overpassPoisQueryVersion(),
    query_builder: buildPoisOverpassQuery,
  })
}
