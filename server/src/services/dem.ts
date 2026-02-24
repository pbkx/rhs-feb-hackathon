import { cacheKey, readJsonCache, writeJsonCache } from "../lib/cache"
import type { OverpassElement, OverpassNode, OverpassResponse, OverpassWay } from "./overpass"

const DEM_API = "https://api.open-meteo.com/v1/elevation"
const MAX_WAYS_FOR_DEM = 800
const DEM_MIN_DELTA_M = 0.8
const DEM_BATCH_SIZE = 90

type FlowDirection = "forward" | "reverse"

export interface DemDirectionResult {
  way_directions: Record<number, FlowDirection>
  sampled_ways: number
  warnings: string[]
}

interface StreamWayEndpoints {
  wayId: number
  first: [number, number] // lon, lat
  last: [number, number] // lon, lat
}

function asTags(tags?: Record<string, string>) {
  return tags ?? {}
}

function isStreamWay(way: OverpassWay) {
  const waterway = asTags(way.tags).waterway
  return (
    waterway === "stream" ||
    waterway === "river" ||
    waterway === "canal" ||
    waterway === "ditch" ||
    waterway === "drain"
  )
}

function parseNodesAndStreamWays(response: OverpassResponse): {
  nodeById: Map<number, OverpassNode>
  streamWays: OverpassWay[]
} {
  const nodeById = new Map<number, OverpassNode>()
  const streamWays: OverpassWay[] = []

  for (const element of response.elements as OverpassElement[]) {
    if (element.type === "node") {
      const node = element as OverpassNode
      nodeById.set(node.id, node)
      continue
    }
    if (element.type === "way") {
      const way = element as OverpassWay
      if (isStreamWay(way)) {
        streamWays.push(way)
      }
    }
  }

  return { nodeById, streamWays }
}

function sampleStreamWayEndpoints(response: OverpassResponse): StreamWayEndpoints[] {
  const { nodeById, streamWays } = parseNodesAndStreamWays(response)
  const ways = streamWays.length > MAX_WAYS_FOR_DEM
    ? streamWays.slice(0, MAX_WAYS_FOR_DEM)
    : streamWays
  const endpoints: StreamWayEndpoints[] = []

  for (const way of ways) {
    if (!way.nodes || way.nodes.length < 2) continue
    const first = nodeById.get(way.nodes[0])
    const last = nodeById.get(way.nodes[way.nodes.length - 1])
    if (!first || !last) continue
    endpoints.push({
      wayId: way.id,
      first: [first.lon, first.lat],
      last: [last.lon, last.lat],
    })
  }

  return endpoints
}

async function fetchElevationBatch(points: Array<[number, number]>): Promise<Array<number | null>> {
  if (points.length === 0) return []

  const latitudes = points.map((point) => point[1].toFixed(6)).join(",")
  const longitudes = points.map((point) => point[0].toFixed(6)).join(",")
  const requestKey = cacheKey(`dem:v1:${latitudes}:${longitudes}`)
  const cached = await readJsonCache<Array<number | null>>("dem", requestKey)
  if (cached) return cached

  const url = new URL(DEM_API)
  url.searchParams.set("latitude", latitudes)
  url.searchParams.set("longitude", longitudes)

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "emp-hackfest/1.0 (+https://localhost)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(25_000),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`DEM request failed ${response.status}: ${text.slice(0, 180)}`)
  }

  const json = (await response.json()) as { elevation?: number[] }
  const elevations = Array.isArray(json.elevation)
    ? json.elevation.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null))
    : []

  const normalized =
    elevations.length === points.length
      ? elevations
      : points.map((_point, index) => elevations[index] ?? null)

  await writeJsonCache("dem", requestKey, normalized)
  return normalized
}

async function fetchElevations(points: Array<[number, number]>): Promise<Array<number | null>> {
  const results: Array<number | null> = []
  for (let index = 0; index < points.length; index += DEM_BATCH_SIZE) {
    const batch = points.slice(index, index + DEM_BATCH_SIZE)
    const values = await fetchElevationBatch(batch)
    results.push(...values)
  }
  return results
}

export async function inferStreamWayDirectionsFromDem(
  response: OverpassResponse
): Promise<DemDirectionResult> {
  const endpoints = sampleStreamWayEndpoints(response)
  const warnings: string[] = []
  if (endpoints.length === 0) {
    return { way_directions: {}, sampled_ways: 0, warnings: ["No stream ways available for DEM sampling."] }
  }

  if (endpoints.length >= MAX_WAYS_FOR_DEM) {
    warnings.push(
      `Digital Elevation Model (DEM) sampling capped at ${MAX_WAYS_FOR_DEM.toLocaleString()} stream ways.`
    )
  }

  const samplePoints: Array<[number, number]> = []
  for (const endpoint of endpoints) {
    samplePoints.push(endpoint.first)
    samplePoints.push(endpoint.last)
  }

  const elevations = await fetchElevations(samplePoints)
  const wayDirections: Record<number, FlowDirection> = {}

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]
    const firstElevation = elevations[index * 2]
    const lastElevation = elevations[index * 2 + 1]
    if (firstElevation === null || lastElevation === null) continue

    if (Math.abs(firstElevation - lastElevation) < DEM_MIN_DELTA_M) continue
    wayDirections[endpoint.wayId] = firstElevation >= lastElevation ? "forward" : "reverse"
  }

  if (Object.keys(wayDirections).length === 0) {
    warnings.push("Digital Elevation Model (DEM) returned limited gradient signal for this area.")
  }

  return {
    way_directions: wayDirections,
    sampled_ways: endpoints.length,
    warnings,
  }
}
