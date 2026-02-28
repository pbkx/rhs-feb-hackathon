import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { cacheKey, readJsonCache, writeJsonCache } from "../lib/cache"
import type { AggregatedReport, BBox, SubmittedReport } from "../types"
import { haversineMeters, pointInBBox } from "../lib/geo"
import { fetchOverpassRaw, type OverpassNode, type OverpassWay } from "./overpass"

function dataDir() {
  return path.join(process.cwd(), "data")
}

function reportsPath() {
  return path.join(dataDir(), "reports.jsonl")
}

const REPORT_SNAP_CACHE_SCOPE = "report-snaps"
const REPORT_SNAP_SEARCH_RADIUS_M = 220
const MAX_REPORT_SNAP_DISTANCE_M = 280
const PEDESTRIAN_HIGHWAYS = new Set(["footway", "path", "pedestrian", "steps", "living_street"])

interface CachedReportSnap {
  snapped_coordinates: [number, number]
  distance_m: number | null
}

interface CachedReportMetrics {
  accessible_unlock_m: number | null
  blocked_segment_m: number | null
  distance_m: number | null
  delta_general_points: number | null
  delta_nas_points: number | null
  delta_oas_points: number | null
  destinations_unlocked: number | null
}

function normalizedCategory(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : "Other"
}

function roundedCoordinate(value: number): string {
  return value.toFixed(5)
}

function normalizeBlockedSteps(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  if (parsed < 0) return null
  return Math.round(parsed)
}

function pointRadiusDegrees(point: [number, number], radiusMeters: number) {
  const lat = point[1]
  const latDelta = radiusMeters / 110_540
  const lonDelta = radiusMeters / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  return { latDelta, lonDelta }
}

function pointToSnapBBox(point: [number, number]): BBox {
  const { latDelta, lonDelta } = pointRadiusDegrees(point, REPORT_SNAP_SEARCH_RADIUS_M)
  return [point[0] - lonDelta, point[1] - latDelta, point[0] + lonDelta, point[1] + latDelta]
}

function reportSnapKey(point: [number, number]) {
  return cacheKey(`report-snap:v1:${roundedCoordinate(point[0])},${roundedCoordinate(point[1])}`)
}

function asCachedCoordinate(value: CachedReportSnap | null): [number, number] | null {
  if (!value) return null
  const coordinates = value.snapped_coordinates
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return null
  const lon = Number(coordinates[0])
  const lat = Number(coordinates[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return [lon, lat]
}

function isPedestrianWay(way: OverpassWay): boolean {
  const tags = way.tags ?? {}
  if (PEDESTRIAN_HIGHWAYS.has(tags.highway ?? "")) return true
  return tags.highway === "service" && tags.service === "alley"
}

function nearestRoadNode(
  point: [number, number],
  nodeById: Map<number, OverpassNode>,
  ways: OverpassWay[]
): { coordinates: [number, number]; distance_m: number } | null {
  const preferredNodeIds = new Set<number>()
  const fallbackNodeIds = new Set<number>()

  for (const way of ways) {
    for (const nodeId of way.nodes) {
      fallbackNodeIds.add(nodeId)
      if (isPedestrianWay(way)) {
        preferredNodeIds.add(nodeId)
      }
    }
  }

  const candidateIds = preferredNodeIds.size > 0 ? preferredNodeIds : fallbackNodeIds
  if (candidateIds.size === 0) return null

  let bestCoordinates: [number, number] | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const nodeId of candidateIds) {
    const node = nodeById.get(nodeId)
    if (!node) continue
    const coordinates: [number, number] = [node.lon, node.lat]
    const distance = haversineMeters(point, coordinates)
    if (distance < bestDistance) {
      bestDistance = distance
      bestCoordinates = coordinates
    }
  }
  if (!bestCoordinates || !Number.isFinite(bestDistance)) return null

  return {
    coordinates: bestCoordinates,
    distance_m: bestDistance,
  }
}

async function snapCoordinateToRoad(coordinates: [number, number]): Promise<[number, number]> {
  const key = reportSnapKey(coordinates)
  const cached = await readJsonCache<CachedReportSnap>(REPORT_SNAP_CACHE_SCOPE, key)
  const cachedCoordinates = asCachedCoordinate(cached)
  if (cachedCoordinates) return cachedCoordinates

  let snappedCoordinates: [number, number] = coordinates
  let snappedDistance: number | null = null

  try {
    const overpass = await fetchOverpassRaw(pointToSnapBBox(coordinates))
    const nodeById = new Map<number, OverpassNode>()
    const ways: OverpassWay[] = []
    for (const element of overpass.elements) {
      if (
        element.type === "node" &&
        "lat" in element &&
        "lon" in element &&
        typeof element.lat === "number" &&
        typeof element.lon === "number"
      ) {
        nodeById.set(element.id, element)
        continue
      }
      if (element.type === "way" && "nodes" in element && Array.isArray(element.nodes)) {
        ways.push(element)
      }
    }

    const nearest = nearestRoadNode(coordinates, nodeById, ways)
    if (nearest && nearest.distance_m <= MAX_REPORT_SNAP_DISTANCE_M) {
      snappedCoordinates = nearest.coordinates
      snappedDistance = nearest.distance_m
    }
  } catch {
    // If snapping fails, keep original coordinates and continue.
  }

  const cacheValue: CachedReportSnap = {
    snapped_coordinates: snappedCoordinates,
    distance_m: snappedDistance !== null ? Number(snappedDistance.toFixed(2)) : null,
  }
  await writeJsonCache(REPORT_SNAP_CACHE_SCOPE, key, cacheValue)
  return snappedCoordinates
}

export function buildReportGroupId(input: {
  barrier_id?: string
  category?: string
  coordinates: [number, number] | null
}) {
  const category = normalizedCategory(input.category).toLowerCase()
  if (input.barrier_id && input.barrier_id.trim().length > 0) {
    return `barrier:${input.barrier_id.trim()}:${category}`
  }
  if (input.coordinates) {
    return `point:${roundedCoordinate(input.coordinates[0])},${roundedCoordinate(input.coordinates[1])}:${category}`
  }
  return `uncategorized:${category}`
}

export async function appendReport(report: SubmittedReport) {
  await mkdir(dataDir(), { recursive: true })
  await appendFile(reportsPath(), `${JSON.stringify(report)}\n`, "utf8")
}

async function readAllReports(): Promise<SubmittedReport[]> {
  try {
    const raw = await readFile(reportsPath(), "utf8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SubmittedReport)
  } catch {
    return []
  }
}

function sortByTimestampAsc(reports: SubmittedReport[]) {
  return [...reports].sort((a, b) => {
    const aTs = Date.parse(a.created_at) || 0
    const bTs = Date.parse(b.created_at) || 0
    return aTs - bTs
  })
}

interface AggregationBucket {
  report_id: string
  created_at: string
  updated_at: string
  last_confirmed_at: string | null
  barrier_id?: string
  category: string
  description: string
  blocked_steps: number | null
  include_coordinates: boolean
  coordinates: [number, number] | null
  reports_count: number
  confirmations: number
  renouncements: number
  has_base_report: boolean
}

function initializeBucket(reportId: string): AggregationBucket {
  const now = new Date(0).toISOString()
  return {
    report_id: reportId,
    created_at: now,
    updated_at: now,
    last_confirmed_at: null,
    barrier_id: undefined,
    category: "Other",
    description: "No description provided.",
    blocked_steps: null,
    include_coordinates: true,
    coordinates: null,
    reports_count: 0,
    confirmations: 0,
    renouncements: 0,
    has_base_report: false,
  }
}

function normalizeLegacyReport(report: SubmittedReport): SubmittedReport & {
  action: "report" | "confirm" | "renounce"
  group_id: string
  category: string
  description: string
  blocked_steps: number | null
} {
  const action = report.action ?? "report"
  const category = normalizedCategory(report.category)
  const description = report.description?.trim() || "No description provided."
  const blocked_steps = normalizeBlockedSteps(report.blocked_steps)
  const group_id =
    report.group_id && report.group_id.trim().length > 0
      ? report.group_id
      : buildReportGroupId({
          barrier_id: report.barrier_id,
          category,
          coordinates: report.coordinates,
        })

  return {
    ...report,
    action,
    group_id,
    category,
    description,
    blocked_steps,
  }
}

function aggregateReports(rows: SubmittedReport[]): AggregatedReport[] {
  const buckets = new Map<string, AggregationBucket>()
  const sorted = sortByTimestampAsc(rows).map(normalizeLegacyReport)

  for (const row of sorted) {
    const bucket = buckets.get(row.group_id) ?? initializeBucket(row.group_id)
    if (!buckets.has(row.group_id)) {
      buckets.set(row.group_id, bucket)
    }

    if (bucket.updated_at < row.created_at) {
      bucket.updated_at = row.created_at
    }

    if (row.action === "report") {
      bucket.reports_count += 1
      bucket.last_confirmed_at = row.created_at

      if (!bucket.has_base_report) {
        bucket.has_base_report = true
        bucket.created_at = row.created_at
        bucket.barrier_id = row.barrier_id
        bucket.category = row.category
        bucket.description = row.description
        bucket.blocked_steps = row.blocked_steps
        bucket.include_coordinates = row.include_coordinates
        bucket.coordinates = row.coordinates
      } else {
        if (!bucket.barrier_id && row.barrier_id) {
          bucket.barrier_id = row.barrier_id
        }
        if (bucket.blocked_steps === null && row.blocked_steps !== null) {
          bucket.blocked_steps = row.blocked_steps
        }
        if (!bucket.coordinates && row.coordinates) {
          bucket.coordinates = row.coordinates
          bucket.include_coordinates = row.include_coordinates
        }
      }
      continue
    }

    if (row.action === "confirm") {
      bucket.confirmations += 1
      bucket.last_confirmed_at = row.created_at
      continue
    }

    bucket.renouncements += 1
  }

  return Array.from(buckets.values())
    .filter((bucket) => bucket.has_base_report)
    .map((bucket) => {
      const reportsCount = bucket.reports_count + bucket.confirmations
      const effective = reportsCount - bucket.renouncements
      const confidence: AggregatedReport["confidence"] =
        effective >= 3 ? "high" : effective >= 2 ? "medium" : "low"
      return {
        report_id: bucket.report_id,
        created_at: bucket.created_at,
        updated_at: bucket.updated_at,
        last_confirmed_at: bucket.last_confirmed_at,
        barrier_id: bucket.barrier_id,
        category: bucket.category,
        description: bucket.description,
        blocked_steps: bucket.blocked_steps,
        include_coordinates: bucket.include_coordinates,
        coordinates: bucket.coordinates,
        reports_count: reportsCount,
        confirmations: bucket.confirmations,
        renouncements: bucket.renouncements,
        effective_reports: effective,
        confidence,
        accessible_unlock_m: null,
        blocked_segment_m: null,
        distance_m: null,
        delta_general_points: null,
        delta_nas_points: null,
        delta_oas_points: null,
        destinations_unlocked: null,
      }
    })
    .sort((a, b) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0))
}

async function snapAggregatedReports(reports: AggregatedReport[]): Promise<AggregatedReport[]> {
  const taskByCoordinate = new Map<string, Promise<[number, number]>>()

  const getSnapped = (coordinates: [number, number]) => {
    const key = `${roundedCoordinate(coordinates[0])},${roundedCoordinate(coordinates[1])}`
    if (!taskByCoordinate.has(key)) {
      taskByCoordinate.set(key, snapCoordinateToRoad(coordinates))
    }
    return taskByCoordinate.get(key) as Promise<[number, number]>
  }

  return Promise.all(
    reports.map(async (report) => {
      if (!report.coordinates) return report
      const snapped = await getSnapped(report.coordinates)
      if (snapped[0] === report.coordinates[0] && snapped[1] === report.coordinates[1]) {
        return report
      }
      return {
        ...report,
        coordinates: snapped,
      }
    })
  )
}

async function enrichReportsWithMetrics(reports: AggregatedReport[]): Promise<AggregatedReport[]> {
  const metricsByReport = new Map<string, CachedReportMetrics | null>()

  const getMetrics = async (reportId: string) => {
    if (!metricsByReport.has(reportId)) {
      const cached = await readJsonCache<CachedReportMetrics>("report-metrics", reportId)
      metricsByReport.set(reportId, cached)
    }
    return metricsByReport.get(reportId) ?? null
  }

  return Promise.all(
    reports.map(async (report) => {
      const metrics = await getMetrics(report.report_id)
      if (!metrics) return report
      return {
        ...report,
        accessible_unlock_m: metrics.accessible_unlock_m,
        blocked_segment_m: metrics.blocked_segment_m,
        distance_m: metrics.distance_m,
        delta_general_points: metrics.delta_general_points,
        delta_nas_points: metrics.delta_nas_points,
        delta_oas_points: metrics.delta_oas_points,
        destinations_unlocked: metrics.destinations_unlocked,
      }
    })
  )
}

export async function listReports(bbox: BBox | null): Promise<AggregatedReport[]> {
  const rows = await readAllReports()
  const aggregated = await enrichReportsWithMetrics(
    await snapAggregatedReports(aggregateReports(rows))
  )
  if (!bbox) return aggregated
  return aggregated.filter((report) => {
    if (!report.coordinates) return false
    return pointInBBox(report.coordinates, bbox)
  })
}

export async function findReportById(reportId: string): Promise<AggregatedReport | null> {
  const reports = await listReports(null)
  return reports.find((report) => report.report_id === reportId) ?? null
}

export async function findReportByIdBase(reportId: string): Promise<AggregatedReport | null> {
  const rows = await readAllReports()
  const aggregated = aggregateReports(rows)
  return aggregated.find((report) => report.report_id === reportId) ?? null
}
