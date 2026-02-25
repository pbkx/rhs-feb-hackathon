import type { FeatureCollection, LineString, Point, Polygon } from "geojson"

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
  confidence: Confidence
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
