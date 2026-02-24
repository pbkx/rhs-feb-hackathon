import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { AggregatedReport, BBox, SubmittedReport } from "../types"
import { pointInBBox } from "../lib/geo"

function dataDir() {
  return path.join(process.cwd(), "data")
}

function reportsPath() {
  return path.join(dataDir(), "reports.jsonl")
}

function normalizedCategory(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : "Other"
}

function roundedCoordinate(value: number): string {
  return value.toFixed(5)
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
} {
  const action = report.action ?? "report"
  const category = normalizedCategory(report.category)
  const description = report.description?.trim() || "No description provided."
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
        bucket.include_coordinates = row.include_coordinates
        bucket.coordinates = row.coordinates
      } else {
        if (!bucket.barrier_id && row.barrier_id) {
          bucket.barrier_id = row.barrier_id
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
        include_coordinates: bucket.include_coordinates,
        coordinates: bucket.coordinates,
        reports_count: reportsCount,
        confirmations: bucket.confirmations,
        renouncements: bucket.renouncements,
        effective_reports: effective,
        confidence,
      }
    })
    .sort((a, b) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0))
}

export async function listReports(bbox: BBox | null): Promise<AggregatedReport[]> {
  const rows = await readAllReports()
  const aggregated = aggregateReports(rows)
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
