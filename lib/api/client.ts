import type { FeatureCollection, LineString, Point, Polygon } from "geojson"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001"

export type BBox = [number, number, number, number]

export type PoiTheme = "healthcare" | "essential"

export interface PoiFeatureProperties {
  poi_id: string
  osm_type: "node" | "way"
  osm_id: number
  name?: string
  kind: string
  theme: PoiTheme
  wheelchair?: string
  toilets_wheelchair?: string
  tags_summary: Record<string, string>
  snapped_node_id?: number | null
  snap_distance_m?: number | null
}

export interface PoisResponse {
  pois_geojson: FeatureCollection<Point, PoiFeatureProperties>
  meta?: {
    bbox: BBox
    overpass_query_version: string
    counts: { pois: number }
    warnings?: string[]
  }
}

export type AccessBlockerType =
  | "stairs"
  | "raised_kerb"
  | "steep_incline"
  | "rough_surface"
  | "wheelchair_no"
  | "wheelchair_limited"
  | "access_no"
  | "report"
  | "other"

export interface AccessBlockerCandidate {
  blocker_id: string
  barrier_id: string
  blocker_type: AccessBlockerType
  name: string
  score: number
  unlock_m: number
  blocked_m: number
  distance_m: number
  delta_nas_points: number
  delta_oas_points: number
  delta_general_points: number
  baseline_general_index: number
  post_fix_general_index: number
  unlocked_poi_count: number
  unlocked_destination_counts: Record<string, number>
  unlocked_component_id: number | null
  confidence: "high" | "medium" | "low"
  osm_id: string
  reports_count?: number
  renouncements?: number
  report_ids?: string[]
  tags: Record<string, string>
  inferred_signals: string[]
  report_signal_count: number
  confidence_bonus: number
  fix_cost_penalty: number
  reason: string
  grouped_component_key: string
  location_label: string
  lat: number
  lon: number
}

export interface AnalyzeResultPayload {
  streams_geojson: FeatureCollection<LineString>
  accessible_streams_geojson: FeatureCollection<LineString>
  blocked_segments_geojson: FeatureCollection<LineString>
  barriers_geojson: FeatureCollection<Point>
  pois_geojson: FeatureCollection<Point, PoiFeatureProperties>
  score_grid_geojson: FeatureCollection<Polygon>
  rankings: AccessBlockerCandidate[]
  meta: {
    bbox: BBox
    warnings: string[]
    calculation_method: string
    overpass_query_version: string
    profile_assumptions: string[]
    accessibility: {
      network_accessibility_score: number
      opportunity_accessibility_score: number
      general_accessibility_index: number
      metrics: {
        coverage_ratio: number
        continuity_ratio: number
        quality_ratio: number
        blocker_pressure_ratio: number
      }
    }
    counts: {
      pedestrian_ways: number
      stream_ways: number
      graph_nodes: number
      pass_edges: number
      limited_edges: number
      blocked_edges: number
      blockers: number
      barriers: number
      components: number
      snapped_pois: number
      unsnapped_pois: number
      reports_used: number
    }
    debug: Record<string, number | string | boolean>
  }
}

interface RunningResult {
  status: "running"
  step: string
}

interface SearchResult {
  display_name: string
  lat: number
  lon: number
  bbox: BBox
  type: string
}

export interface ReportRecord {
  report_id: string
  created_at: string
  updated_at: string
  last_confirmed_at: string | null
  barrier_id?: string
  category: string
  description: string
  email?: string
  blocked_steps: number | null
  include_coordinates: boolean
  coordinates: [number, number] | null
  reports_count: number
  confirmations: number
  renouncements: number
  effective_reports: number
  confidence: "high" | "medium" | "low"
  accessible_unlock_m: number | null
  blocked_segment_m: number | null
  distance_m: number | null
  delta_general_points: number | null
  delta_nas_points: number | null
  delta_oas_points: number | null
  destinations_unlocked: number | null
}

export interface BootstrapResponse {
  analysis_payload: AnalyzeResultPayload
  reports: ReportRecord[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const json = await response.json()
      message = json?.error?.message ?? message
    } catch {
      // no-op
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

export async function analyze(
  bbox: BBox,
  anchor?: [number, number] | null,
  anchorPoiId?: string | null
): Promise<{ job_id: string }> {
  return request<{ job_id: string }>("/analyze", {
    method: "POST",
    body: JSON.stringify({
      bbox,
      anchor: anchor ?? null,
      anchor_poi_id: anchorPoiId ?? null,
    }),
  })
}

export async function getResult(jobId: string): Promise<RunningResult | AnalyzeResultPayload> {
  const response = await fetch(`${API_BASE_URL}/result/${jobId}`)
  if (response.status === 202) {
    return (await response.json()) as RunningResult
  }
  if (!response.ok) {
    let message = `Result request failed (${response.status})`
    try {
      const json = await response.json()
      message = json?.error?.message ?? message
    } catch {
      // no-op
    }
    throw new Error(message)
  }
  return (await response.json()) as AnalyzeResultPayload
}

export async function getPois(bbox: BBox): Promise<PoisResponse> {
  return request<PoisResponse>(`/pois?bbox=${bbox.join(",")}`)
}

export async function search(query: string): Promise<SearchResult[]> {
  return request<SearchResult[]>(`/search?q=${encodeURIComponent(query)}`)
}

export async function submitReport(payload: {
  barrier_id?: string
  category: string
  description: string
  email?: string
  blocked_steps?: number
  include_coordinates: boolean
  coordinates: [number, number] | null
}): Promise<{ ok: true; report_id: string }> {
  return request<{ ok: true; report_id: string }>("/reports", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function getReports(bbox?: BBox): Promise<{ reports: ReportRecord[] }> {
  const query = bbox ? `?bbox=${bbox.join(",")}` : ""
  return request<{ reports: ReportRecord[] }>(`/reports${query}`)
}

export async function submitReportFeedback(
  reportId: string,
  action: "confirm" | "renounce"
): Promise<{ ok: true; report_id: string; action: "confirm" | "renounce" }> {
  return request<{ ok: true; report_id: string; action: "confirm" | "renounce" }>(
    `/reports/${encodeURIComponent(reportId)}/feedback`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
    }
  )
}

export async function getBootstrap(): Promise<BootstrapResponse> {
  return request<BootstrapResponse>("/bootstrap")
}
