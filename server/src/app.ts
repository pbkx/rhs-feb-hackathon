import { randomUUID } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import cors from "cors"
import express from "express"
import { z } from "zod"
import { cacheKey, readJsonCache, writeJsonCache } from "./lib/cache"
import { bboxAreaDegrees, haversineMeters, normalizeBBox } from "./lib/geo"
import { ANALYSIS_CALCULATION_METHOD, runAnalysisPipeline } from "./services/analysis"
import { overpassToPoisGeojson } from "./services/pois"
import {
  fetchOverpassPois,
  fetchOverpassRaw,
  overpassPoisQueryVersion,
  overpassQueryVersion,
} from "./services/overpass"
import {
  appendReport,
  buildReportGroupId,
  findReportById,
  findReportByIdBase,
  listReports,
} from "./services/reports"
import { searchNominatim } from "./services/search"
import type {
  AccessBlockerCandidate,
  AggregatedReport,
  AnalysisComputed,
  AnalysisResultPayload,
  AnalyzeJob,
  BBox,
  JobError,
  SubmittedReport,
} from "./types"

const MAX_ANALYZE_BBOX_AREA_DEGREES = 0.24
const MAX_POI_BBOX_AREA_DEGREES = 0.45
const REPORT_METRIC_RADIUS_KM = 2.2
const jobs = new Map<string, AnalyzeJob>()

const bboxSchema = z
  .array(z.number())
  .length(4)
  .transform((bbox) => normalizeBBox(bbox as BBox))
  .refine((bbox) => bbox[0] < bbox[2] && bbox[1] < bbox[3], "Invalid bbox coordinates")
  .refine((bbox) => bboxAreaDegrees(bbox) <= MAX_ANALYZE_BBOX_AREA_DEGREES, "BBox too large for demo")

const analyzeSchema = z.object({
  bbox: bboxSchema,
  anchor: z.tuple([z.number(), z.number()]).optional().nullable(),
  anchor_poi_id: z.string().optional().nullable(),
})

const allowedReportCategories = [
  "Blocked sidewalk",
  "Broken curb ramp",
  "No curb ramp",
  "Elevator out of service",
  "Construction detour",
  "Flooded path",
  "Unsafe crossing",
  "Accessibility issue",
  "Incorrect blocker",
  "Other",
  "Dam",
  "Weir",
  "Waterfall",
  "Incorrect barrier",
] as const

const reportSchema = z.object({
  barrier_id: z.string().optional(),
  category: z.enum(allowedReportCategories),
  description: z.string().min(1),
  email: z.string().email().optional(),
  blocked_steps: z.number().int().min(0).max(10_000).optional(),
  include_coordinates: z.boolean(),
  coordinates: z.tuple([z.number(), z.number()]).nullable(),
})

const reportFeedbackSchema = z.object({
  action: z.enum(["confirm", "renounce"]),
})

const sharedBarrierSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  gain: z.number(),
  upstreamBlocked: z.number(),
  confidence: z.enum(["high", "medium", "low"]),
  distance: z.number(),
  deltaNas: z.number(),
  deltaOas: z.number(),
  deltaGeneral: z.number(),
  baselineIndex: z.number(),
  postFixIndex: z.number(),
  unlockedPoiCount: z.number(),
  unlockedDestinationCounts: z.record(z.number()),
  unlockedComponentId: z.number().nullable(),
  score: z.number(),
  osmId: z.string().min(1),
  reportCount: z.number().optional(),
  renouncements: z.number().optional(),
  tags: z.record(z.string()),
  inferredSignals: z.array(z.string()),
  reason: z.string().optional(),
  locationLabel: z.string().optional(),
  calculationMethod: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
})

const sharedReportSchema = z.object({
  report_id: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  last_confirmed_at: z.string().nullable(),
  barrier_id: z.string().optional(),
  category: z.string().min(1),
  description: z.string().min(1),
  blocked_steps: z.number().int().nullable(),
  include_coordinates: z.boolean(),
  coordinates: z.tuple([z.number(), z.number()]).nullable(),
  reports_count: z.number().int(),
  confirmations: z.number().int(),
  renouncements: z.number().int(),
  effective_reports: z.number().int(),
  confidence: z.enum(["high", "medium", "low"]),
  accessible_unlock_m: z.number().nullable(),
  blocked_segment_m: z.number().nullable(),
  distance_m: z.number().nullable(),
  delta_general_points: z.number().nullable(),
  delta_nas_points: z.number().nullable(),
  delta_oas_points: z.number().nullable(),
  destinations_unlocked: z.number().nullable(),
  calculation_method: z.string().nullable(),
})

const shareCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("barrier"),
    barrier: sharedBarrierSchema,
  }),
  z.object({
    kind: z.literal("report"),
    report: sharedReportSchema,
  }),
])

type SharedCacheRecord =
  | {
      kind: "barrier"
      barrier: z.infer<typeof sharedBarrierSchema>
      created_at: string
    }
  | {
      kind: "report"
      report: z.infer<typeof sharedReportSchema>
      created_at: string
    }

function asJobError(error: unknown): JobError {
  if (error instanceof Error) {
    return { message: error.message, code: "ANALYSIS_FAILED" }
  }
  return { message: "Unknown analysis error", code: "ANALYSIS_FAILED" }
}

async function runAnalyzeJob(
  jobId: string,
  input: { bbox: BBox; anchor: [number, number] | null; anchor_poi_id: string | null }
): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return

  try {
    job.status = "running"
    job.step = "checking_cache"
    job.updated_at = new Date().toISOString()

    const areaReports = await listReports(input.bbox)
    const reportDigest = cacheKey(
      JSON.stringify(
        areaReports
          .filter((report) => report.effective_reports > 0)
          .map((report) => [report.report_id, report.updated_at, report.effective_reports])
      )
    )
    const resultCacheKey = cacheKey(
      JSON.stringify({
        bbox: input.bbox,
        anchor: input.anchor,
        anchor_poi_id: input.anchor_poi_id,
        report_digest: reportDigest,
        overpass_query_version: overpassQueryVersion(),
      })
    )
    const cached = await readJsonCache<AnalysisComputed>("results", resultCacheKey)
    if (cached) {
      job.status = "done"
      job.step = "complete_cached"
      job.payload = cached.payload
      job.updated_at = new Date().toISOString()
      return
    }

    job.step = "fetching_overpass"
    job.updated_at = new Date().toISOString()
    const overpassRaw = await fetchOverpassRaw(input.bbox)

    job.step = "loading_reports"
    job.updated_at = new Date().toISOString()

    job.step = "building_access_graph"
    job.updated_at = new Date().toISOString()
    const computed: AnalysisComputed = runAnalysisPipeline(
      overpassRaw,
      input.bbox,
      overpassQueryVersion(),
      {
        anchor: input.anchor,
        anchor_poi_id: input.anchor_poi_id,
        reports: areaReports,
      }
    )

    job.step = "ranking_blockers"
    job.updated_at = new Date().toISOString()

    job.step = "saving_cache"
    job.updated_at = new Date().toISOString()
    await writeJsonCache("results", resultCacheKey, computed)

    job.status = "done"
    job.step = "complete"
    job.payload = computed.payload
    job.updated_at = new Date().toISOString()
  } catch (error) {
    const asError = asJobError(error)
    job.status = "error"
    job.step = "error"
    job.error = asError
    job.updated_at = new Date().toISOString()
    console.error("[analyze] error", error)
  }
}

function parseBboxQuery(value: string | undefined): BBox | null {
  if (!value) return null
  const parts = value.split(",").map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((num) => Number.isNaN(num))) return null
  const bbox = normalizeBBox(parts as BBox)
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null
  return bbox
}

interface ReportMetricSnapshot {
  accessible_unlock_m: number | null
  blocked_segment_m: number | null
  distance_m: number | null
  delta_general_points: number | null
  delta_nas_points: number | null
  delta_oas_points: number | null
  destinations_unlocked: number | null
  calculation_method: string | null
}

function bboxFromCenterRadiusKm(center: [number, number], radiusKm: number): BBox {
  const [lon, lat] = center
  const latDelta = radiusKm / 110.54
  const lonDelta = radiusKm / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  return normalizeBBox([lon - lonDelta, lat - latDelta, lon + lonDelta, lat + latDelta] as BBox)
}

function toNullableNumber(value: unknown, decimals = 2): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Number(parsed.toFixed(decimals))
}

function stepCountToMeters(blockedSteps: number | null) {
  if (blockedSteps === null || blockedSteps < 0) return 0
  return blockedSteps * 0.3
}

function defaultReportMetrics(report: AggregatedReport): ReportMetricSnapshot {
  return {
    accessible_unlock_m: 0,
    blocked_segment_m: stepCountToMeters(report.blocked_steps),
    distance_m: null,
    delta_general_points: 0,
    delta_nas_points: 0,
    delta_oas_points: 0,
    destinations_unlocked: 0,
    calculation_method: null,
  }
}

function metricsFromCandidate(
  candidate: AccessBlockerCandidate,
  blockedSteps: number | null,
  calculationMethod: string | null
): ReportMetricSnapshot {
  return {
    accessible_unlock_m: toNullableNumber(candidate.unlock_m, 0),
    blocked_segment_m:
      toNullableNumber(candidate.blocked_m, 0) ??
      (blockedSteps !== null ? stepCountToMeters(blockedSteps) : 0),
    distance_m: toNullableNumber(candidate.distance_m, 0),
    delta_general_points: toNullableNumber(candidate.delta_general_points, 3),
    delta_nas_points: toNullableNumber(candidate.delta_nas_points, 3),
    delta_oas_points: toNullableNumber(candidate.delta_oas_points, 3),
    destinations_unlocked: toNullableNumber(candidate.unlocked_poi_count, 0),
    calculation_method: calculationMethod,
  }
}

function pickReportMetricsCandidate(
  rankings: AccessBlockerCandidate[],
  report: AggregatedReport
): AccessBlockerCandidate | null {
  const reportCandidates = rankings.filter((candidate) => candidate.blocker_type === "report")
  if (reportCandidates.length === 0) return null

  const direct = reportCandidates.find(
    (candidate) =>
      Array.isArray(candidate.report_ids) && candidate.report_ids.includes(report.report_id)
  )
  if (direct) return direct

  if (!report.coordinates) return null
  let best: AccessBlockerCandidate | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of reportCandidates) {
    const distance = haversineMeters(report.coordinates, [candidate.lon, candidate.lat])
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  if (bestDistance > 120) return null
  return best
}

async function computeAndCacheReportMetrics(reportId: string): Promise<void> {
  try {
    const report = await findReportById(reportId)
    if (!report) return

    let metrics = defaultReportMetrics(report)
    let candidate: AccessBlockerCandidate | null = null
    let calculationMethod: string | null = null

    if (report.coordinates) {
      const bbox = bboxFromCenterRadiusKm(report.coordinates, REPORT_METRIC_RADIUS_KM)
      const [overpassRaw, areaReports] = await Promise.all([
        fetchOverpassRaw(bbox),
        listReports(bbox),
      ])
      const computed = runAnalysisPipeline(overpassRaw, bbox, overpassQueryVersion(), {
        anchor: report.coordinates,
        reports: areaReports,
      })
      calculationMethod = computed.payload.meta.calculation_method
      candidate = pickReportMetricsCandidate(computed.payload.rankings, report)
    } else if (report.barrier_id) {
      const mergedCache = mergeCachedPayloads(await readCachedResultPayloads())
      calculationMethod = mergedCache.meta.calculation_method
      candidate =
        mergedCache.rankings.find((ranking) => ranking.barrier_id === report.barrier_id) ?? null
    }

    if (candidate) {
      metrics = metricsFromCandidate(candidate, report.blocked_steps, calculationMethod)
    } else if (calculationMethod) {
      metrics = {
        ...metrics,
        calculation_method: calculationMethod,
      }
    }

    await writeJsonCache("report-metrics", reportId, metrics)
  } catch (error) {
    console.warn("[reports] metric compute failed", error)
  }
}

function resultsCacheDir() {
  return path.join(process.cwd(), "cache", "results")
}

function isValidBBox(value: unknown): value is BBox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  )
}

function emptyBootstrapPayload(): AnalysisResultPayload {
  return {
    streams_geojson: { type: "FeatureCollection", features: [] },
    accessible_streams_geojson: { type: "FeatureCollection", features: [] },
    blocked_segments_geojson: { type: "FeatureCollection", features: [] },
    barriers_geojson: { type: "FeatureCollection", features: [] },
    pois_geojson: { type: "FeatureCollection", features: [] },
    score_grid_geojson: { type: "FeatureCollection", features: [] },
    rankings: [],
    meta: {
      bbox: [-180, -85, 180, 85],
      warnings: [],
      calculation_method: ANALYSIS_CALCULATION_METHOD,
      overpass_query_version: "bootstrap-cache-v1",
      profile_assumptions: ["Cached barriers and reports merged across prior analysis runs"],
      accessibility: {
        network_accessibility_score: 0,
        opportunity_accessibility_score: 0,
        general_accessibility_index: 0,
        metrics: {
          coverage_ratio: 0,
          continuity_ratio: 0,
          quality_ratio: 0,
          blocker_pressure_ratio: 0,
        },
      },
      counts: {
        pedestrian_ways: 0,
        stream_ways: 0,
        graph_nodes: 0,
        pass_edges: 0,
        limited_edges: 0,
        blocked_edges: 0,
        blockers: 0,
        barriers: 0,
        components: 0,
        snapped_pois: 0,
        unsnapped_pois: 0,
        reports_used: 0,
      },
      debug: {
        source: "bootstrap",
      },
    },
  }
}

function normalizeCachedPayload(raw: unknown): AnalysisResultPayload | null {
  if (!raw || typeof raw !== "object") return null
  const asObject = raw as { payload?: unknown } & Record<string, unknown>
  const candidate = asObject.payload ?? asObject
  if (!candidate || typeof candidate !== "object") return null
  const payload = candidate as Partial<AnalysisResultPayload>
  if (!Array.isArray(payload.rankings)) return null
  if (!payload.barriers_geojson || !Array.isArray(payload.barriers_geojson.features)) return null
  return payload as AnalysisResultPayload
}

async function readCachedResultPayloads(limit = 80): Promise<AnalysisResultPayload[]> {
  try {
    const entries = await readdir(resultsCacheDir(), { withFileTypes: true })
    const jsonNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
    if (jsonNames.length === 0) return []

    const withStats = await Promise.all(
      jsonNames.map(async (name) => {
        const fullPath = path.join(resultsCacheDir(), name)
        const info = await stat(fullPath)
        return { name, fullPath, mtime: info.mtimeMs }
      })
    )

    withStats.sort((left, right) => right.mtime - left.mtime)
    const selected = withStats.slice(0, limit)

    const payloads: AnalysisResultPayload[] = []
    for (const file of selected) {
      try {
        const raw = JSON.parse(await readFile(file.fullPath, "utf8")) as unknown
        const normalized = normalizeCachedPayload(raw)
        if (normalized) payloads.push(normalized)
      } catch {
        // Ignore invalid cache file entries.
      }
    }
    return payloads
  } catch {
    return []
  }
}

function mergeBBox(current: BBox | null, next: unknown): BBox | null {
  if (!isValidBBox(next)) return current
  if (!current) return [...next] as BBox
  return [
    Math.min(current[0], next[0]),
    Math.min(current[1], next[1]),
    Math.max(current[2], next[2]),
    Math.max(current[3], next[3]),
  ]
}

function mergeCachedPayloads(payloads: AnalysisResultPayload[]): AnalysisResultPayload {
  if (payloads.length === 0) return emptyBootstrapPayload()

  const fallbackMeta = emptyBootstrapPayload().meta
  const rankingByBarrier = new Map<string, AccessBlockerCandidate>()
  const blockedByEdge = new Map<string, AnalysisResultPayload["blocked_segments_geojson"]["features"][number]>()
  const warnings = new Set<string>(fallbackMeta.warnings)
  const profileAssumptions = new Set<string>(fallbackMeta.profile_assumptions)
  const latestMetaWithCalculation = payloads.find(
    (payload) =>
      typeof payload.meta?.calculation_method === "string" &&
      payload.meta.calculation_method.trim().length > 0
  )?.meta
  const calculationMethod =
    latestMetaWithCalculation?.calculation_method ?? fallbackMeta.calculation_method
  const overpassQueryVersion =
    latestMetaWithCalculation?.overpass_query_version ?? fallbackMeta.overpass_query_version
  let mergedBBox: BBox | null = null

  for (const payload of payloads) {
    mergedBBox = mergeBBox(mergedBBox, payload.meta?.bbox)
    for (const warning of payload.meta?.warnings ?? []) {
      if (typeof warning === "string" && warning.trim().length > 0) {
        warnings.add(warning)
      }
    }
    for (const assumption of payload.meta?.profile_assumptions ?? []) {
      if (typeof assumption === "string" && assumption.trim().length > 0) {
        profileAssumptions.add(assumption)
      }
    }

    for (const ranking of payload.rankings ?? []) {
      if (!ranking?.barrier_id) continue
      if (!Number.isFinite(ranking.lon) || !Number.isFinite(ranking.lat)) continue
      const existing = rankingByBarrier.get(ranking.barrier_id)
      if (!existing || ranking.score > existing.score) {
        rankingByBarrier.set(ranking.barrier_id, ranking)
      }
    }

    for (const feature of payload.blocked_segments_geojson?.features ?? []) {
      if (feature.geometry?.type !== "LineString") continue
      const props = (feature.properties ?? {}) as Record<string, unknown>
      const edgeId = typeof props.edge_id === "string" ? props.edge_id : null
      if (!edgeId || blockedByEdge.has(edgeId)) continue
      blockedByEdge.set(edgeId, feature)
    }
  }

  const rankings = [...rankingByBarrier.values()]
    .sort((left, right) => right.score - left.score || right.unlock_m - left.unlock_m)
    .slice(0, 3200)

  const barriers_geojson: AnalysisResultPayload["barriers_geojson"] = {
    type: "FeatureCollection",
    features: rankings.map((candidate) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [candidate.lon, candidate.lat] },
      properties: {
        barrier_id: candidate.barrier_id,
        blocker_id: candidate.blocker_id,
        type: candidate.blocker_type,
        name: candidate.name,
        unlock_m: candidate.unlock_m,
        blocked_m: candidate.blocked_m,
        delta_nas_points: candidate.delta_nas_points,
        delta_oas_points: candidate.delta_oas_points,
        delta_general_points: candidate.delta_general_points,
        baseline_general_index: candidate.baseline_general_index,
        post_fix_general_index: candidate.post_fix_general_index,
        unlocked_component_id: candidate.unlocked_component_id,
        grouped_component_key: candidate.grouped_component_key,
        score: candidate.score,
        confidence: candidate.confidence,
        report_signal_count: candidate.report_signal_count,
      },
    })),
  }

  const blocked_segments_geojson: AnalysisResultPayload["blocked_segments_geojson"] = {
    type: "FeatureCollection",
    features: [...blockedByEdge.values()],
  }

  return {
    streams_geojson: { type: "FeatureCollection", features: [] },
    accessible_streams_geojson: { type: "FeatureCollection", features: [] },
    blocked_segments_geojson,
    barriers_geojson,
    pois_geojson: { type: "FeatureCollection", features: [] },
    score_grid_geojson: { type: "FeatureCollection", features: [] },
    rankings,
    meta: {
      ...fallbackMeta,
      bbox: mergedBBox ?? [-180, -85, 180, 85],
      warnings: [...warnings],
      calculation_method: calculationMethod,
      overpass_query_version: overpassQueryVersion,
      profile_assumptions: [...profileAssumptions],
      counts: {
        ...fallbackMeta.counts,
        blockers: rankings.length,
        barriers: rankings.length,
        blocked_edges: blocked_segments_geojson.features.length,
      },
      debug: {
        source: "bootstrap",
        cached_payloads: payloads.length,
        calculation_method_source: latestMetaWithCalculation ? "cached-result" : "fallback",
      },
    },
  }
}

async function loadBootstrapData(): Promise<{
  analysis_payload: AnalysisResultPayload
  reports: AggregatedReport[]
}> {
  const [payloads, reports] = await Promise.all([readCachedResultPayloads(), listReports(null)])
  return {
    analysis_payload: mergeCachedPayloads(payloads),
    reports,
  }
}

export function createApp() {
  const app = express()

  const origin = process.env.FRONTEND_ORIGIN?.trim()
  app.use(
    cors({
      origin: origin ? origin.split(",").map((item) => item.trim()) : true,
    })
  )
  app.use(express.json({ limit: "1mb" }))

  app.get("/health", (_req, res) => {
    res.json({ ok: true })
  })

  app.get("/bootstrap", async (_req, res) => {
    try {
      const bootstrap = await loadBootstrapData()
      return res.json(bootstrap)
    } catch (error) {
      console.error("[bootstrap] error", error)
      return res
        .status(500)
        .json({ error: { message: "Failed to load bootstrap cache", code: "BOOTSTRAP_FAILED" } })
    }
  })

  app.get("/pois", async (req, res) => {
    try {
      const bboxRaw = typeof req.query.bbox === "string" ? req.query.bbox : undefined
      const bbox = parseBboxQuery(bboxRaw)
      if (bboxRaw && !bbox) {
        return res.status(400).json({ error: { message: "Invalid bbox query", code: "BAD_REQUEST" } })
      }
      if (!bbox) {
        return res.status(400).json({ error: { message: "bbox query is required", code: "BAD_REQUEST" } })
      }

      const area = bboxAreaDegrees(bbox)
      if (area > MAX_POI_BBOX_AREA_DEGREES) {
        return res.status(400).json({
          error: {
            message: "BBox too large for POI query. Zoom in before requesting POIs.",
            code: "POI_BBOX_TOO_LARGE",
          },
        })
      }

      const overpassRaw = await fetchOverpassPois(bbox)
      const pois_geojson = overpassToPoisGeojson(overpassRaw)
      return res.json({
        pois_geojson,
        meta: {
          bbox,
          overpass_query_version: overpassPoisQueryVersion(),
          counts: { pois: pois_geojson.features.length },
          warnings:
            area > MAX_POI_BBOX_AREA_DEGREES / 2
              ? ["Large viewport detected; POI density may be incomplete in highly mapped areas."]
              : [],
        },
      })
    } catch (error) {
      console.error("[pois] error", error)
      return res.status(500).json({ error: { message: "POI query failed", code: "POI_QUERY_FAILED" } })
    }
  })

  app.post("/analyze", (req, res) => {
    const parsed = analyzeSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        error: { message: parsed.error.issues[0]?.message ?? "Invalid analyze payload", code: "BAD_REQUEST" },
      })
    }

    const job_id = randomUUID()
    const now = new Date().toISOString()
    jobs.set(job_id, {
      id: job_id,
      status: "running",
      step: "queued",
      created_at: now,
      updated_at: now,
    })

    const { bbox, anchor, anchor_poi_id } = parsed.data
    void runAnalyzeJob(job_id, { bbox, anchor: anchor ?? null, anchor_poi_id: anchor_poi_id ?? null })
    return res.json({ job_id })
  })

  app.get("/result/:job_id", (req, res) => {
    const job = jobs.get(req.params.job_id)
    if (!job) {
      return res.status(404).json({ error: { message: "Job not found", code: "JOB_NOT_FOUND" } })
    }

    if (job.status === "running") {
      return res.status(202).json({ status: "running", step: job.step })
    }
    if (job.status === "error") {
      return res.status(500).json({ error: job.error ?? { message: "Analysis failed", code: "ANALYSIS_FAILED" } })
    }
    if (!job.payload) {
      return res.status(500).json({ error: { message: "Missing analysis payload", code: "MISSING_PAYLOAD" } })
    }
    return res.status(200).json(job.payload)
  })

  app.get("/search", async (req, res) => {
    try {
      const q = String(req.query.q ?? "").trim()
      if (!q) {
        return res.status(400).json({ error: { message: "Query q is required", code: "BAD_REQUEST" } })
      }
      const results = await searchNominatim(q)
      return res.json(results)
    } catch (error) {
      console.error("[search] error", error)
      return res.status(500).json({ error: { message: "Search failed", code: "SEARCH_FAILED" } })
    }
  })

  app.post("/share", async (req, res) => {
    const parsed = shareCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        error: { message: parsed.error.issues[0]?.message ?? "Invalid share payload", code: "BAD_REQUEST" },
      })
    }

    try {
      const created_at = new Date().toISOString()
      const cacheRecord: SharedCacheRecord =
        parsed.data.kind === "barrier"
          ? {
              kind: "barrier",
              barrier: parsed.data.barrier,
              created_at,
            }
          : {
              kind: "report",
              report: parsed.data.report,
              created_at,
            }
      const cache_id = cacheKey(JSON.stringify({ v: 1, ...cacheRecord }))
      await writeJsonCache("shares", cache_id, cacheRecord)
      return res.json({ ok: true, cache_id })
    } catch (error) {
      console.error("[share] save error", error)
      return res.status(500).json({ error: { message: "Failed to save share payload", code: "SHARE_SAVE_FAILED" } })
    }
  })

  app.get("/share/:cache_id", async (req, res) => {
    try {
      const cacheId = String(req.params.cache_id ?? "").trim()
      if (!cacheId) {
        return res.status(400).json({ error: { message: "cache_id is required", code: "BAD_REQUEST" } })
      }
      const shared = await readJsonCache<SharedCacheRecord>("shares", cacheId)
      if (!shared) {
        return res.status(404).json({ error: { message: "Shared payload not found", code: "SHARE_NOT_FOUND" } })
      }
      return res.json({
        ok: true,
        cache_id: cacheId,
        ...shared,
      })
    } catch (error) {
      console.error("[share] load error", error)
      return res.status(500).json({ error: { message: "Failed to load shared payload", code: "SHARE_LOAD_FAILED" } })
    }
  })

  app.post("/reports", async (req, res) => {
    const parsed = reportSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        error: { message: parsed.error.issues[0]?.message ?? "Invalid report payload", code: "BAD_REQUEST" },
      })
    }

    try {
      const payload = parsed.data
      const groupId = buildReportGroupId({
        barrier_id: payload.barrier_id,
        category: payload.category,
        coordinates: payload.include_coordinates ? payload.coordinates : null,
      })
      const report: SubmittedReport = {
        report_id: randomUUID(),
        group_id: groupId,
        created_at: new Date().toISOString(),
        action: "report",
        barrier_id: payload.barrier_id,
        category: payload.category,
        description: payload.description,
        email: payload.email,
        blocked_steps: payload.blocked_steps ?? null,
        include_coordinates: payload.include_coordinates,
        coordinates: payload.include_coordinates ? payload.coordinates : null,
      }
      await appendReport(report)
      await computeAndCacheReportMetrics(report.report_id)
      return res.json({ ok: true, report_id: report.report_id })
    } catch (error) {
      console.error("[reports] append error", error)
      return res.status(500).json({ error: { message: "Failed to save report", code: "REPORT_SAVE_FAILED" } })
    }
  })

  app.post("/reports/:report_id/feedback", async (req, res) => {
    const parsed = reportFeedbackSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        error: { message: parsed.error.issues[0]?.message ?? "Invalid feedback payload", code: "BAD_REQUEST" },
      })
    }

    try {
      const existing = await findReportByIdBase(req.params.report_id)
      if (!existing) {
        return res.status(404).json({ error: { message: "Report not found", code: "REPORT_NOT_FOUND" } })
      }

      const feedback: SubmittedReport = {
        report_id: randomUUID(),
        group_id: existing.report_id,
        created_at: new Date().toISOString(),
        action: parsed.data.action,
        barrier_id: existing.barrier_id,
        category: existing.category,
        description: existing.description,
        blocked_steps: existing.blocked_steps,
        include_coordinates: Boolean(existing.coordinates),
        coordinates: existing.coordinates,
      }

      await appendReport(feedback)
      void computeAndCacheReportMetrics(existing.report_id)
      return res.json({ ok: true, report_id: existing.report_id, action: parsed.data.action })
    } catch (error) {
      console.error("[reports] feedback error", error)
      return res.status(500).json({ error: { message: "Failed to save report feedback", code: "REPORT_FEEDBACK_FAILED" } })
    }
  })

  app.get("/reports", async (req, res) => {
    try {
      const bboxRaw = typeof req.query.bbox === "string" ? req.query.bbox : undefined
      const bbox = parseBboxQuery(bboxRaw)
      if (bboxRaw && !bbox) {
        return res.status(400).json({ error: { message: "Invalid bbox query", code: "BAD_REQUEST" } })
      }

      const reports = await listReports(bbox)
      return res.json({ reports })
    } catch (error) {
      console.error("[reports] list error", error)
      return res.status(500).json({ error: { message: "Failed to list reports", code: "REPORT_LIST_FAILED" } })
    }
  })

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] unhandled", error)
    res.status(500).json({ error: { message: "Internal server error", code: "INTERNAL_ERROR" } })
  })

  return app
}
