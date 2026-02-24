import { randomUUID } from "node:crypto"
import cors from "cors"
import express from "express"
import { z } from "zod"
import { cacheKey, readJsonCache, writeJsonCache } from "./lib/cache"
import { bboxAreaDegrees, normalizeBBox } from "./lib/geo"
import { runAnalysisPipeline } from "./services/analysis"
import { overpassToPoisGeojson } from "./services/pois"
import {
  fetchOverpassPois,
  fetchOverpassRaw,
  overpassPoisQueryVersion,
  overpassQueryVersion,
} from "./services/overpass"
import { appendReport, buildReportGroupId, findReportById, listReports } from "./services/reports"
import { searchNominatim } from "./services/search"
import type {
  AnalysisComputed,
  AnalyzeJob,
  BBox,
  JobError,
  SubmittedReport,
} from "./types"

const MAX_ANALYZE_BBOX_AREA_DEGREES = 0.24
const MAX_POI_BBOX_AREA_DEGREES = 0.45
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
  include_coordinates: z.boolean(),
  coordinates: z.tuple([z.number(), z.number()]).nullable(),
})

const reportFeedbackSchema = z.object({
  action: z.enum(["confirm", "renounce"]),
})

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
        include_coordinates: payload.include_coordinates,
        coordinates: payload.include_coordinates ? payload.coordinates : null,
      }
      await appendReport(report)
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
      const existing = await findReportById(req.params.report_id)
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
        include_coordinates: Boolean(existing.coordinates),
        coordinates: existing.coordinates,
      }

      await appendReport(feedback)
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
