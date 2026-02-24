import type { FeatureCollection, LineString, Point } from "geojson"

export type BBox = [number, number, number, number]

export type Confidence = "high" | "medium" | "low"

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
    counts: {
      pois: number
    }
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
  unlock_km: number
  gain_km: number
  blocked_km: number
  unlocked_healthcare_score: number
  unlocked_essentials_score: number
  unlocked_healthcare_counts: Record<string, number>
  unlocked_essentials_counts: Record<string, number>
  confidence: Confidence
  distance_km: number
  osm_id: string
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

export interface AnalysisResultPayload {
  streams_geojson: FeatureCollection<LineString>
  accessible_streams_geojson: FeatureCollection<LineString>
  blocked_segments_geojson: FeatureCollection<LineString>
  barriers_geojson: FeatureCollection<Point>
  pois_geojson: FeatureCollection<Point, PoiFeatureProperties>
  rankings: AccessBlockerCandidate[]
  meta: {
    bbox: BBox
    warnings: string[]
    calculation_method: string
    overpass_query_version: string
    profile_assumptions: string[]
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

export interface AnalysisComputed {
  payload: AnalysisResultPayload
}

export interface JobError {
  message: string
  code: string
}

export interface AnalyzeJob {
  id: string
  status: "running" | "done" | "error"
  step: string
  created_at: string
  updated_at: string
  payload?: AnalysisResultPayload
  error?: JobError
}

export interface SearchResult {
  display_name: string
  lat: number
  lon: number
  bbox: BBox
  type: string
}

export interface SubmittedReport {
  report_id: string
  group_id?: string
  created_at: string
  action?: "report" | "confirm" | "renounce"
  barrier_id?: string
  category?: string
  description?: string
  email?: string
  include_coordinates: boolean
  coordinates: [number, number] | null
}

export interface AggregatedReport {
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
  effective_reports: number
  confidence: "high" | "medium" | "low"
}
