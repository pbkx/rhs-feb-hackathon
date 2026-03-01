import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  LineString,
  Point,
  Polygon,
} from "geojson"
import { bboxCenter, haversineMeters } from "../lib/geo"
import type {
  AccessBlockerCandidate,
  AccessBlockerType,
  AggregatedReport,
  AnalysisComputed,
  BBox,
  Confidence,
  PoiFeatureProperties,
} from "../types"
import { overpassToPoisGeojson } from "./pois"
import type { OverpassElement, OverpassNode, OverpassResponse, OverpassWay } from "./overpass"

const MAX_GRAPH_NODES = 220_000
const MAX_GRAPH_EDGES = 360_000
const MAX_POI_SNAP_DISTANCE_M = 220
const MAX_ANCHOR_SNAP_DISTANCE_M = 450
const REPORT_SIGNAL_DISTANCE_M = 70
const MAX_REPORT_SNAP_DISTANCE_M = 260
export const ANALYSIS_CALCULATION_METHOD =
  "General Accessibility Index = 0.7 * Network Accessibility Score + 0.3 * Opportunity Accessibility Score. Blockers are ranked by simulated post-fix score delta and unlocked passable meters."

const PEDESTRIAN_HIGHWAYS = new Set(["footway", "path", "pedestrian", "steps", "living_street"])
const BLOCKED_ACCESS_VALUES = new Set(["no", "private", "military"])
const ROUGH_SURFACES = new Set([
  "gravel",
  "ground",
  "dirt",
  "sand",
  "pebblestone",
  "unpaved",
  "mud",
  "woodchips",
])
const POOR_SMOOTHNESS = new Set(["bad", "very_bad", "horrible", "very_horrible", "impassable"])
const HARD_REPORT_CATEGORIES = new Set([
  "blocked sidewalk",
  "broken curb ramp",
  "no curb ramp",
  "elevator out of service",
  "construction detour",
  "flooded path",
  "unsafe crossing",
  "accessibility issue",
])

type Coord = [number, number]
type EdgeStatus = "PASS" | "LIMITED" | "BLOCKED"

class SpatialHash<T> {
  private buckets = new Map<string, T[]>()

  constructor(private cellLon = 0.02, private cellLat = 0.02) {}

  private key(ix: number, iy: number) {
    return `${ix}:${iy}`
  }

  private lonIndex(lon: number) {
    return Math.floor(lon / this.cellLon)
  }

  private latIndex(lat: number) {
    return Math.floor(lat / this.cellLat)
  }

  insertPoint(point: Coord, value: T) {
    this.insertBBox(point[0], point[1], point[0], point[1], value)
  }

  insertBBox(minLon: number, minLat: number, maxLon: number, maxLat: number, value: T) {
    const minX = this.lonIndex(Math.min(minLon, maxLon))
    const maxX = this.lonIndex(Math.max(minLon, maxLon))
    const minY = this.latIndex(Math.min(minLat, maxLat))
    const maxY = this.latIndex(Math.max(minLat, maxLat))
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const bucketKey = this.key(x, y)
        if (!this.buckets.has(bucketKey)) this.buckets.set(bucketKey, [])
        this.buckets.get(bucketKey)?.push(value)
      }
    }
  }

  queryBBox(minLon: number, minLat: number, maxLon: number, maxLat: number): T[] {
    const minX = this.lonIndex(Math.min(minLon, maxLon))
    const maxX = this.lonIndex(Math.max(minLon, maxLon))
    const minY = this.latIndex(Math.min(minLat, maxLat))
    const maxY = this.latIndex(Math.max(minLat, maxLat))
    const values = new Set<T>()
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const bucket = this.buckets.get(this.key(x, y))
        if (!bucket) continue
        for (const value of bucket) {
          values.add(value)
        }
      }
    }
    return [...values]
  }
}

class DisjointSet {
  private parent = new Map<number, number>()
  private size = new Map<number, number>()

  makeSet(value: number) {
    if (this.parent.has(value)) return
    this.parent.set(value, value)
    this.size.set(value, 1)
  }

  find(value: number): number {
    if (!this.parent.has(value)) {
      this.makeSet(value)
      return value
    }
    const parent = this.parent.get(value)
    if (parent === value || parent === undefined) return value
    const root = this.find(parent)
    this.parent.set(value, root)
    return root
  }

  union(left: number, right: number) {
    const rootLeft = this.find(left)
    const rootRight = this.find(right)
    if (rootLeft === rootRight) return
    const leftSize = this.size.get(rootLeft) ?? 1
    const rightSize = this.size.get(rootRight) ?? 1
    if (leftSize < rightSize) {
      this.parent.set(rootLeft, rootRight)
      this.size.set(rootRight, leftSize + rightSize)
      return
    }
    this.parent.set(rootRight, rootLeft)
    this.size.set(rootLeft, leftSize + rightSize)
  }
}

interface EdgeClassification {
  status: EdgeStatus
  blocker_type: AccessBlockerType | null
  confidence: Confidence
  inferred_signals: string[]
  quality_score: number
}

interface PedestrianEdge {
  edge_id: string
  way_id: number
  from: number
  to: number
  from_coord: Coord
  to_coord: Coord
  mid_coord: Coord
  length_m: number
  tags: Record<string, string>
  classification: EdgeClassification
  location_label: string
}

interface ComponentStats {
  length_m: number
  poi_count: number
  destination_counts: Record<string, number>
}

interface CandidateInternal {
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

interface AnalysisOptions {
  anchor?: Coord | null
  anchor_poi_id?: string | null
  reports?: AggregatedReport[]
}

interface ReportSignal {
  report_id: string
  category: string
  confidence: Confidence
  effective_reports: number
  reports_count: number
  renouncements: number
  coordinates: Coord
}

interface ReportEdgeEvidence {
  effective_reports: number
  reports_count: number
  renouncements: number
  confidence: Confidence
  categories: Set<string>
  report_ids: Set<string>
}

interface AccessibilityScores {
  coverage_ratio: number
  continuity_ratio: number
  quality_ratio: number
  blocker_pressure_ratio: number
  network_accessibility_score: number
}

function asTags(tags?: Record<string, string>) {
  return tags ?? {}
}

function lineFeature(coords: Coord[], properties: GeoJsonProperties): Feature<LineString> {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties,
  }
}

function pointFeature(point: Coord, properties: GeoJsonProperties): Feature<Point> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: point },
    properties,
  }
}

function polygonFeature(coords: Coord[], properties: GeoJsonProperties): Feature<Polygon> {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [coords] },
    properties,
  }
}

function pointRadiusDegrees(point: Coord, radiusMeters: number) {
  const lat = point[1]
  const latDelta = radiusMeters / 110_540
  const lonDelta = radiusMeters / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  return { latDelta, lonDelta }
}

function nearestGraphNode(
  point: Coord,
  index: SpatialHash<number>,
  nodeById: Map<number, OverpassNode>,
  maxDistanceM: number
): { node_id: number; distance_m: number } | null {
  const { latDelta, lonDelta } = pointRadiusDegrees(point, maxDistanceM)
  const nearby = index.queryBBox(
    point[0] - lonDelta,
    point[1] - latDelta,
    point[0] + lonDelta,
    point[1] + latDelta
  )
  if (nearby.length === 0) return null

  let bestNode: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const nodeId of nearby) {
    const node = nodeById.get(nodeId)
    if (!node) continue
    const distance = haversineMeters(point, [node.lon, node.lat])
    if (distance < bestDistance) {
      bestDistance = distance
      bestNode = nodeId
    }
  }
  if (bestNode === null || bestDistance > maxDistanceM) return null
  return { node_id: bestNode, distance_m: bestDistance }
}

function reportCategoryIsHard(category: string) {
  return HARD_REPORT_CATEGORIES.has(category.toLowerCase().trim())
}

function edgeDistanceToPointMeters(edge: PedestrianEdge, point: Coord) {
  return Math.min(
    haversineMeters(edge.mid_coord, point),
    haversineMeters(edge.from_coord, point),
    haversineMeters(edge.to_coord, point)
  )
}

function nearestEdgeIndex(
  point: Coord,
  edges: PedestrianEdge[],
  index: SpatialHash<number>,
  maxDistanceM: number,
  includeAlreadyBlocked = false
): { edge_index: number; distance_m: number } | null {
  const { latDelta, lonDelta } = pointRadiusDegrees(point, maxDistanceM)
  const nearby = index.queryBBox(
    point[0] - lonDelta,
    point[1] - latDelta,
    point[0] + lonDelta,
    point[1] + latDelta
  )
  if (nearby.length === 0) return null

  let bestEdgeIndex: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const edgeIndex of nearby) {
    const edge = edges[edgeIndex]
    if (!edge) continue
    if (!includeAlreadyBlocked && edge.classification.status === "BLOCKED") continue
    const distance = edgeDistanceToPointMeters(edge, point)
    if (distance < bestDistance) {
      bestDistance = distance
      bestEdgeIndex = edgeIndex
    }
  }

  if (bestEdgeIndex === null || !Number.isFinite(bestDistance) || bestDistance > maxDistanceM) {
    return null
  }
  return { edge_index: bestEdgeIndex, distance_m: bestDistance }
}

function bruteForceNearestNode(point: Coord, nodeById: Map<number, OverpassNode>) {
  let bestNode: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const node of nodeById.values()) {
    const distance = haversineMeters(point, [node.lon, node.lat])
    if (distance < bestDistance) {
      bestDistance = distance
      bestNode = node.id
    }
  }
  if (bestNode === null) return null
  return { node_id: bestNode, distance_m: bestDistance }
}

function isPedestrianWay(tags: Record<string, string>) {
  if (PEDESTRIAN_HIGHWAYS.has(tags.highway)) return true
  if (tags.highway === "service" && tags.service === "alley") return true
  return false
}

function parseInclineTag(raw: string | undefined): number | null {
  if (!raw) return null
  const value = raw.trim().toLowerCase()
  if (!value || value === "up" || value === "down" || value === "yes" || value === "no") {
    return null
  }
  const normalized = value.replace(",", ".")
  const parsed = Number.parseFloat(normalized)
  if (!Number.isFinite(parsed)) return null
  if (normalized.includes("%")) return Math.abs(parsed)
  if (normalized.includes("°")) {
    const radians = (parsed * Math.PI) / 180
    return Math.abs(Math.tan(radians) * 100)
  }
  if (Math.abs(parsed) <= 1) return Math.abs(parsed * 100)
  return Math.abs(parsed)
}

function blockerFixCostPenalty(type: AccessBlockerType) {
  switch (type) {
    case "stairs":
      return 1.2
    case "access_no":
      return 1.1
    case "wheelchair_no":
      return 0.95
    case "raised_kerb":
      return 0.55
    case "steep_incline":
      return 0.75
    case "rough_surface":
      return 0.45
    case "wheelchair_limited":
      return 0.4
    case "report":
      return 0.55
    default:
      return 0.6
  }
}

function confidenceBonus(confidence: Confidence) {
  if (confidence === "high") return 0.6
  if (confidence === "medium") return 0.3
  return 0.05
}

function bumpConfidence(base: Confidence, report: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }
  const target = Math.max(rank[base], rank[report])
  if (target >= 2) return "high"
  if (target >= 1) return "medium"
  return "low"
}

function classifyPedestrianEdgeAccessibility(
  tags: Record<string, string>,
  hasRaisedKerbEndpoint: boolean
): EdgeClassification {
  if (tags.highway === "steps") {
    return {
      status: "BLOCKED",
      blocker_type: "stairs",
      confidence: "high",
      inferred_signals: ["Tagged highway=steps, not wheelchair-passable."],
      quality_score: 0,
    }
  }
  if (tags.wheelchair === "no") {
    return {
      status: "BLOCKED",
      blocker_type: "wheelchair_no",
      confidence: "high",
      inferred_signals: ["Tagged wheelchair=no."],
      quality_score: 0,
    }
  }
  if (BLOCKED_ACCESS_VALUES.has(tags.access ?? "") || BLOCKED_ACCESS_VALUES.has(tags.foot ?? "")) {
    return {
      status: "BLOCKED",
      blocker_type: "access_no",
      confidence: "high",
      inferred_signals: ["Tagged access/foot restriction blocks pedestrian use."],
      quality_score: 0,
    }
  }
  if (hasRaisedKerbEndpoint) {
    return {
      status: "BLOCKED",
      blocker_type: "raised_kerb",
      confidence: "high",
      inferred_signals: ["Connected to kerb=raised crossing node."],
      quality_score: 0,
    }
  }

  if (tags.wheelchair === "limited") {
    return {
      status: "LIMITED",
      blocker_type: "wheelchair_limited",
      confidence: "high",
      inferred_signals: ["Tagged wheelchair=limited."],
      quality_score: 0.62,
    }
  }
  const inclinePct = parseInclineTag(tags.incline)
  if (inclinePct !== null && inclinePct >= 8) {
    return {
      status: "LIMITED",
      blocker_type: "steep_incline",
      confidence: "medium",
      inferred_signals: [`Incline tag suggests ~${inclinePct.toFixed(1)}% slope.`],
      quality_score: 0.55,
    }
  }
  if (typeof tags.surface === "string" && ROUGH_SURFACES.has(tags.surface)) {
    return {
      status: "LIMITED",
      blocker_type: "rough_surface",
      confidence: "medium",
      inferred_signals: [`Surface tagged ${tags.surface}.`],
      quality_score: 0.58,
    }
  }
  if (typeof tags.smoothness === "string" && POOR_SMOOTHNESS.has(tags.smoothness)) {
    return {
      status: "LIMITED",
      blocker_type: "rough_surface",
      confidence: "medium",
      inferred_signals: [`Smoothness tagged ${tags.smoothness}.`],
      quality_score: 0.52,
    }
  }
  return {
    status: "PASS",
    blocker_type: null,
    confidence: "medium",
    inferred_signals: [],
    quality_score: 1,
  }
}

function incrementCount(target: Record<string, number>, key: string, amount = 1) {
  target[key] = (target[key] ?? 0) + amount
}

function cloneCounts(counts: Record<string, number>) {
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value]))
}

function kindLabel(type: AccessBlockerType) {
  switch (type) {
    case "stairs":
      return "Stairs"
    case "raised_kerb":
      return "Raised kerb"
    case "steep_incline":
      return "Steep incline"
    case "rough_surface":
      return "Rough surface"
    case "wheelchair_no":
      return "Wheelchair=no"
    case "wheelchair_limited":
      return "Wheelchair=limited"
    case "access_no":
      return "Access restricted"
    case "report":
      return "Reported blocker"
    default:
      return "Mobility blocker"
  }
}

function formatLocationLabel(tags: Record<string, string>, lon: number, lat: number) {
  if (typeof tags.name === "string" && tags.name.trim().length > 0) return tags.name.trim()
  const street = tags["addr:street"] ?? tags["name:en"]
  if (street) return street
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
}

function summarizeUnlockedDestinations(destinationCounts: Record<string, number>) {
  const summary = Object.entries(destinationCounts)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([kind, count]) => `${count} ${kind}`)
  return summary.length > 0 ? summary.join(", ") : "no snapped destinations"
}

function sanitizeTags(tags: Record<string, string>) {
  const output: Record<string, string> = {}
  const keep = [
    "highway",
    "footway",
    "wheelchair",
    "surface",
    "smoothness",
    "incline",
    "access",
    "foot",
    "ramp",
    "lit",
    "name",
  ]
  for (const key of keep) {
    const value = tags[key]
    if (typeof value === "string" && value.trim().length > 0) {
      output[key] = value
    }
  }
  return output
}

function createEmptyComponentStats(): ComponentStats {
  return {
    length_m: 0,
    poi_count: 0,
    destination_counts: {},
  }
}

function computeNetworkAccessibilityScores(input: {
  total_length_m: number
  pass_length_m: number
  limited_length_m: number
  blocked_edges: number
  largest_pass_component_length_m: number
}): AccessibilityScores {
  const total = Math.max(input.total_length_m, 1)
  const pass = Math.max(input.pass_length_m, 0)
  const limited = Math.max(input.limited_length_m, 0)
  const coverageRatio = Math.min(1, pass / total)
  const continuityRatio = pass > 0 ? Math.min(1, input.largest_pass_component_length_m / pass) : 0
  const qualityRatio = Math.min(1, (pass + limited * 0.6) / total)
  const blockedPerKm = input.blocked_edges / Math.max(0.5, total / 1000)
  const blockerPressureRatio = Math.min(1, blockedPerKm / 3)
  const nas =
    100 *
    (0.35 * coverageRatio +
      0.3 * continuityRatio +
      0.2 * qualityRatio +
      0.15 * (1 - blockerPressureRatio))
  return {
    coverage_ratio: coverageRatio,
    continuity_ratio: continuityRatio,
    quality_ratio: qualityRatio,
    blocker_pressure_ratio: blockerPressureRatio,
    network_accessibility_score: nas,
  }
}

function buildScoreGridGeojson(
  bbox: BBox,
  edges: PedestrianEdge[],
  cols = 8,
  rows = 8
): FeatureCollection<Polygon> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const lonStep = (maxLon - minLon) / cols
  const latStep = (maxLat - minLat) / rows
  const features: Feature<Polygon>[] = []

  for (let x = 0; x < cols; x += 1) {
    for (let y = 0; y < rows; y += 1) {
      const cellMinLon = minLon + x * lonStep
      const cellMaxLon = minLon + (x + 1) * lonStep
      const cellMinLat = minLat + y * latStep
      const cellMaxLat = minLat + (y + 1) * latStep

      const localEdges = edges.filter((edge) => {
        const [lon, lat] = edge.mid_coord
        return lon >= cellMinLon && lon < cellMaxLon && lat >= cellMinLat && lat < cellMaxLat
      })
      if (localEdges.length === 0) continue

      let totalLength = 0
      let passLength = 0
      let limitedLength = 0
      let blockedCount = 0
      for (const edge of localEdges) {
        totalLength += edge.length_m
        if (edge.classification.status === "PASS") passLength += edge.length_m
        if (edge.classification.status === "LIMITED") limitedLength += edge.length_m
        if (edge.classification.status === "BLOCKED") blockedCount += 1
      }

      const local = computeNetworkAccessibilityScores({
        total_length_m: totalLength,
        pass_length_m: passLength,
        limited_length_m: limitedLength,
        blocked_edges: blockedCount,
        largest_pass_component_length_m: passLength,
      })

      features.push(
        polygonFeature(
          [
            [cellMinLon, cellMinLat],
            [cellMaxLon, cellMinLat],
            [cellMaxLon, cellMaxLat],
            [cellMinLon, cellMaxLat],
            [cellMinLon, cellMinLat],
          ],
          {
            grid_id: `${x}-${y}`,
            nas_score: Number(local.network_accessibility_score.toFixed(2)),
            edge_count: localEdges.length,
          }
        )
      )
    }
  }
  return {
    type: "FeatureCollection",
    features,
  }
}

function toPublicCandidate(candidate: CandidateInternal): AccessBlockerCandidate {
  const output: AccessBlockerCandidate = {
    blocker_id: candidate.blocker_id,
    barrier_id: candidate.barrier_id,
    blocker_type: candidate.blocker_type,
    name: candidate.name,
    score: Number(candidate.score.toFixed(3)),
    unlock_m: Math.max(0, Math.round(candidate.unlock_m)),
    blocked_m: Math.max(0, Math.round(candidate.blocked_m)),
    distance_m: Math.max(0, Math.round(candidate.distance_m)),
    delta_nas_points: Number(candidate.delta_nas_points.toFixed(3)),
    delta_oas_points: Number(candidate.delta_oas_points.toFixed(3)),
    delta_general_points: Number(candidate.delta_general_points.toFixed(3)),
    baseline_general_index: Number(candidate.baseline_general_index.toFixed(3)),
    post_fix_general_index: Number(candidate.post_fix_general_index.toFixed(3)),
    unlocked_poi_count: candidate.unlocked_poi_count,
    unlocked_destination_counts: cloneCounts(candidate.unlocked_destination_counts),
    unlocked_component_id: candidate.unlocked_component_id,
    confidence: candidate.confidence,
    osm_id: candidate.osm_id,
    tags: sanitizeTags(candidate.tags),
    inferred_signals: [...new Set(candidate.inferred_signals)],
    report_signal_count: candidate.report_signal_count,
    confidence_bonus: Number(candidate.confidence_bonus.toFixed(2)),
    fix_cost_penalty: Number(candidate.fix_cost_penalty.toFixed(2)),
    reason: candidate.reason,
    grouped_component_key: candidate.grouped_component_key,
    location_label: candidate.location_label,
    lat: Number(candidate.lat.toFixed(6)),
    lon: Number(candidate.lon.toFixed(6)),
  }
  if (typeof candidate.reports_count === "number" && Number.isFinite(candidate.reports_count)) {
    output.reports_count = Math.max(0, Math.round(candidate.reports_count))
  }
  if (typeof candidate.renouncements === "number" && Number.isFinite(candidate.renouncements)) {
    output.renouncements = Math.max(0, Math.round(candidate.renouncements))
  }
  if (Array.isArray(candidate.report_ids) && candidate.report_ids.length > 0) {
    output.report_ids = [...new Set(candidate.report_ids)]
  }
  return output
}

export function runAnalysisPipeline(
  response: OverpassResponse,
  bbox: BBox,
  overpass_query_version: string,
  options: AnalysisOptions = {}
): AnalysisComputed {
  const warnings: string[] = []
  const nodeById = new Map<number, OverpassNode>()
  const pedestrianWays: OverpassWay[] = []
  const raisedKerbNodeIds = new Set<number>()

  for (const element of response.elements as OverpassElement[]) {
    if (element.type === "node") {
      const node = element as OverpassNode
      nodeById.set(node.id, node)
      const tags = asTags(node.tags)
      if (tags.barrier === "kerb" && tags.kerb === "raised") {
        raisedKerbNodeIds.add(node.id)
      }
      continue
    }
    if (element.type === "way") {
      const way = element as OverpassWay
      if (isPedestrianWay(asTags(way.tags))) {
        pedestrianWays.push(way)
      }
    }
  }

  const nodeIndex = new SpatialHash<number>(0.01, 0.01)
  const graphNodeIds = new Set<number>()
  const edges: PedestrianEdge[] = []

  for (const way of pedestrianWays) {
    const tags = asTags(way.tags)
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) continue
    for (let index = 0; index < way.nodes.length - 1; index += 1) {
      const fromId = way.nodes[index]
      const toId = way.nodes[index + 1]
      const fromNode = nodeById.get(fromId)
      const toNode = nodeById.get(toId)
      if (!fromNode || !toNode) continue
      const fromCoord: Coord = [fromNode.lon, fromNode.lat]
      const toCoord: Coord = [toNode.lon, toNode.lat]
      const midCoord: Coord = [(fromCoord[0] + toCoord[0]) / 2, (fromCoord[1] + toCoord[1]) / 2]

      graphNodeIds.add(fromId)
      graphNodeIds.add(toId)
      nodeIndex.insertPoint(fromCoord, fromId)
      nodeIndex.insertPoint(toCoord, toId)

      const classification = classifyPedestrianEdgeAccessibility(
        tags,
        raisedKerbNodeIds.has(fromId) || raisedKerbNodeIds.has(toId)
      )
      edges.push({
        edge_id: `${way.id}-${index}`,
        way_id: way.id,
        from: fromId,
        to: toId,
        from_coord: fromCoord,
        to_coord: toCoord,
        mid_coord: midCoord,
        length_m: haversineMeters(fromCoord, toCoord),
        tags,
        classification,
        location_label: formatLocationLabel(tags, midCoord[0], midCoord[1]),
      })
    }
  }

  const reportSignals: ReportSignal[] = (options.reports ?? [])
    .filter(
      (report): report is AggregatedReport & { coordinates: Coord } =>
        report.effective_reports > 0 &&
        Array.isArray(report.coordinates) &&
        report.coordinates.length === 2
    )
    .map((report) => ({
      report_id: report.report_id,
      category: report.category,
      confidence: report.confidence,
      effective_reports: report.effective_reports,
      reports_count: report.reports_count,
      renouncements: report.renouncements,
      coordinates: report.coordinates,
    }))

  const edgeIndex = new SpatialHash<number>(0.01, 0.01)
  edges.forEach((edge, index) => edgeIndex.insertPoint(edge.mid_coord, index))

  const reportEvidenceByEdge = new Map<string, ReportEdgeEvidence>()
  const reportMatchedByEdgeIds = new Set<string>()
  for (const report of reportSignals) {
    if (!reportCategoryIsHard(report.category)) continue

    const nearest = nearestEdgeIndex(
      report.coordinates,
      edges,
      edgeIndex,
      MAX_REPORT_SNAP_DISTANCE_M,
      false
    )
    if (!nearest) continue

    const edge = edges[nearest.edge_index]
    if (!edge) continue

    const current = reportEvidenceByEdge.get(edge.edge_id)
    if (current) {
      current.effective_reports += report.effective_reports
      current.reports_count += report.reports_count
      current.renouncements += report.renouncements
      current.confidence = bumpConfidence(current.confidence, report.confidence)
      current.categories.add(report.category)
      current.report_ids.add(report.report_id)
    } else {
      reportEvidenceByEdge.set(edge.edge_id, {
        effective_reports: report.effective_reports,
        reports_count: report.reports_count,
        renouncements: report.renouncements,
        confidence: report.confidence,
        categories: new Set([report.category]),
        report_ids: new Set([report.report_id]),
      })
    }
    reportMatchedByEdgeIds.add(report.report_id)
  }

  for (const edge of edges) {
    const evidence = reportEvidenceByEdge.get(edge.edge_id)
    if (!evidence) continue
    const categoryPreview = [...evidence.categories].slice(0, 3).join(", ")
    edge.classification = {
      status: "BLOCKED",
      blocker_type: "report",
      confidence: bumpConfidence(edge.classification.confidence, evidence.confidence),
      inferred_signals: [
        ...edge.classification.inferred_signals,
        `Community reports indicate a blocker (${evidence.reports_count} reports, ${evidence.renouncements} renouncements).`,
        ...(categoryPreview ? [`Reported categories: ${categoryPreview}.`] : []),
      ],
      quality_score: 0,
    }
  }

  if (graphNodeIds.size > MAX_GRAPH_NODES || edges.length > MAX_GRAPH_EDGES) {
    throw new Error("Area too large for analysis. Click a POI in a denser neighborhood or zoom in first.")
  }
  if (edges.length === 0) {
    warnings.push("No mapped pedestrian network found in this area.")
  }

  const dsu = new DisjointSet()
  for (const nodeId of graphNodeIds) dsu.makeSet(nodeId)
  for (const edge of edges) {
    if (edge.classification.status === "PASS") {
      dsu.union(edge.from, edge.to)
    }
  }

  const componentStats = new Map<number, ComponentStats>()
  const ensureComponent = (componentId: number) => {
    if (!componentStats.has(componentId)) {
      componentStats.set(componentId, createEmptyComponentStats())
    }
    return componentStats.get(componentId) as ComponentStats
  }
  for (const nodeId of graphNodeIds) {
    ensureComponent(dsu.find(nodeId))
  }

  let totalLengthM = 0
  let passLengthM = 0
  let limitedLengthM = 0
  let blockedLengthM = 0
  let blockedEdgesCount = 0
  for (const edge of edges) {
    totalLengthM += edge.length_m
    if (edge.classification.status === "PASS") {
      passLengthM += edge.length_m
      const componentId = dsu.find(edge.from)
      ensureComponent(componentId).length_m += edge.length_m
      continue
    }
    if (edge.classification.status === "LIMITED") {
      limitedLengthM += edge.length_m
    } else {
      blockedLengthM += edge.length_m
      blockedEdgesCount += 1
    }
  }

  let largestPassComponentLength = 0
  for (const stats of componentStats.values()) {
    if (stats.length_m > largestPassComponentLength) {
      largestPassComponentLength = stats.length_m
    }
  }

  const rawPoisGeojson = overpassToPoisGeojson(response)
  const snappedPoiFeatures: Feature<Point, PoiFeatureProperties>[] = []
  let snappedPois = 0
  let unsnappedPois = 0
  for (const feature of rawPoisGeojson.features) {
    if (feature.geometry?.type !== "Point" || !feature.properties) continue
    const coords = feature.geometry.coordinates as Coord
    const snapped = nearestGraphNode(coords, nodeIndex, nodeById, MAX_POI_SNAP_DISTANCE_M)
    const enriched: PoiFeatureProperties = {
      ...feature.properties,
      snapped_node_id: snapped?.node_id ?? null,
      snap_distance_m: snapped ? Number(snapped.distance_m.toFixed(2)) : null,
    }
    if (snapped) {
      snappedPois += 1
      const componentId = dsu.find(snapped.node_id)
      const stats = ensureComponent(componentId)
      stats.poi_count += 1
      incrementCount(stats.destination_counts, feature.properties.kind, 1)
    } else {
      unsnappedPois += 1
    }
    snappedPoiFeatures.push({ ...feature, properties: enriched })
  }

  const pois_geojson: FeatureCollection<Point, PoiFeatureProperties> = {
    type: "FeatureCollection",
    features: snappedPoiFeatures,
  }

  const anchorPoint = options.anchor ?? bboxCenter(bbox)
  let anchorSnap = nearestGraphNode(anchorPoint, nodeIndex, nodeById, MAX_ANCHOR_SNAP_DISTANCE_M)
  if (!anchorSnap && nodeById.size > 0) {
    anchorSnap = bruteForceNearestNode(anchorPoint, nodeById)
    if (anchorSnap) {
      warnings.push("Anchor POI could not be snapped with high confidence; using nearest mapped network node.")
    }
  }

  let baseComponentId: number | null = null
  if (anchorSnap) {
    baseComponentId = dsu.find(anchorSnap.node_id)
  } else {
    let bestComponent: number | null = null
    let bestLength = -1
    for (const [componentId, stats] of componentStats.entries()) {
      if (stats.length_m > bestLength) {
        bestLength = stats.length_m
        bestComponent = componentId
      }
    }
    baseComponentId = bestComponent
    warnings.push("Could not snap anchor point; using the largest passable component as fallback.")
  }

  const baseStats = baseComponentId !== null ? componentStats.get(baseComponentId) : null
  const baseReachablePois = baseStats?.poi_count ?? 0
  const baselineOpportunityScore = snappedPois > 0 ? (100 * baseReachablePois) / snappedPois : 50
  const baselineNetwork = computeNetworkAccessibilityScores({
    total_length_m: totalLengthM,
    pass_length_m: passLengthM,
    limited_length_m: limitedLengthM,
    blocked_edges: blockedEdgesCount,
    largest_pass_component_length_m: largestPassComponentLength,
  })
  const baselineGeneralScore =
    baselineNetwork.network_accessibility_score * 0.7 + baselineOpportunityScore * 0.3

  const rawCandidates: CandidateInternal[] = []
  const blockedSegmentsFeatures: Feature<LineString>[] = []

  for (const edge of edges) {
    if (edge.classification.status === "PASS") continue

    blockedSegmentsFeatures.push(
      lineFeature([edge.from_coord, edge.to_coord], {
        edge_id: edge.edge_id,
        way_id: edge.way_id,
        blocker_type: edge.classification.blocker_type ?? "other",
        status: edge.classification.status,
        quality_score: edge.classification.quality_score,
      })
    )

    const leftComponent = dsu.find(edge.from)
    const rightComponent = dsu.find(edge.to)
    if (leftComponent === rightComponent) continue
    if (baseComponentId === null) continue

    let otherComponent: number | null = null
    if (leftComponent === baseComponentId && rightComponent !== baseComponentId) {
      otherComponent = rightComponent
    } else if (rightComponent === baseComponentId && leftComponent !== baseComponentId) {
      otherComponent = leftComponent
    }
    if (otherComponent === null) continue

    const otherStats = componentStats.get(otherComponent)
    if (!otherStats) continue

    const unlockMeters = otherStats.length_m
    const postPassLength = passLengthM + edge.length_m
    const postLargestLength = Math.max(
      largestPassComponentLength,
      (baseStats?.length_m ?? 0) + otherStats.length_m + edge.length_m
    )
    const postNetwork = computeNetworkAccessibilityScores({
      total_length_m: totalLengthM,
      pass_length_m: postPassLength,
      limited_length_m: limitedLengthM,
      blocked_edges: Math.max(0, blockedEdgesCount - 1),
      largest_pass_component_length_m: postLargestLength,
    })
    const postOpportunity =
      snappedPois > 0 ? (100 * (baseReachablePois + otherStats.poi_count)) / snappedPois : 50
    const postGeneral = postNetwork.network_accessibility_score * 0.7 + postOpportunity * 0.3
    const deltaNas = postNetwork.network_accessibility_score - baselineNetwork.network_accessibility_score
    const deltaOas = postOpportunity - baselineOpportunityScore
    const deltaGeneral = postGeneral - baselineGeneralScore

    const blockerType = edge.classification.blocker_type ?? "other"
    const reportEvidence =
      blockerType === "report" ? reportEvidenceByEdge.get(edge.edge_id) : undefined
    const reportSignalCount = reportEvidence?.effective_reports ?? 0
    const fixPenalty = blockerFixCostPenalty(blockerType)
    const confidenceBoost = confidenceBonus(edge.classification.confidence)
    const score = deltaGeneral * 3 + unlockMeters / 750 + confidenceBoost - fixPenalty
    const reportSummary =
      reportEvidence && reportEvidence.categories.size > 0
        ? [...reportEvidence.categories].slice(0, 3).join(", ")
        : ""
    const reason =
      blockerType === "report" && reportEvidence
        ? `Community reports (${reportEvidence.reports_count} reports, ${reportEvidence.renouncements} renouncements) indicate a blocker here. Fix reconnects ${Math.round(
            unlockMeters
          )} m of passable network and unlocks ${summarizeUnlockedDestinations(
            otherStats.destination_counts
          )}.${reportSummary ? ` Categories: ${reportSummary}.` : ""}`
        : `Fix reconnects ${Math.round(unlockMeters)} m of passable network and unlocks ${summarizeUnlockedDestinations(
            otherStats.destination_counts
          )}.`

    rawCandidates.push({
      blocker_id: `blk-${edge.edge_id}`,
      barrier_id: `blk-${edge.edge_id}`,
      blocker_type: blockerType,
      name: kindLabel(blockerType),
      score,
      unlock_m: unlockMeters,
      blocked_m: edge.length_m,
      distance_m: haversineMeters(anchorPoint, edge.mid_coord),
      delta_nas_points: deltaNas,
      delta_oas_points: deltaOas,
      delta_general_points: deltaGeneral,
      baseline_general_index: baselineGeneralScore,
      post_fix_general_index: postGeneral,
      unlocked_poi_count: otherStats.poi_count,
      unlocked_destination_counts: cloneCounts(otherStats.destination_counts),
      unlocked_component_id: otherComponent,
      confidence: edge.classification.confidence,
      osm_id: blockerType === "report" ? "N/A" : `way/${edge.way_id}`,
      reports_count: reportEvidence?.reports_count,
      renouncements: reportEvidence?.renouncements,
      report_ids: reportEvidence ? [...reportEvidence.report_ids] : undefined,
      tags: edge.tags,
      inferred_signals: [...edge.classification.inferred_signals],
      report_signal_count: reportSignalCount,
      confidence_bonus: confidenceBoost,
      fix_cost_penalty: fixPenalty,
      reason,
      grouped_component_key: `${baseComponentId}->${otherComponent}`,
      location_label: edge.location_label,
      lat: edge.mid_coord[1],
      lon: edge.mid_coord[0],
    })
  }

  const reportIndex = new SpatialHash<number>(0.015, 0.015)
  reportSignals.forEach((report, index) => reportIndex.insertPoint(report.coordinates, index))
  const matchedReportIds = new Set<string>(reportMatchedByEdgeIds)

  const candidatesWithReports = rawCandidates.map((candidate) => {
    const point: Coord = [candidate.lon, candidate.lat]
    const { latDelta, lonDelta } = pointRadiusDegrees(point, REPORT_SIGNAL_DISTANCE_M)
    const nearbyIndexes = reportIndex.queryBBox(
      point[0] - lonDelta,
      point[1] - latDelta,
      point[0] + lonDelta,
      point[1] + latDelta
    )

    let nearbyEffective = 0
    let strongestConfidence: Confidence = candidate.confidence
    const categories = new Set<string>()
    for (const reportIdx of nearbyIndexes) {
      const report = reportSignals[reportIdx]
      if (!report) continue
      if (haversineMeters(point, report.coordinates) > REPORT_SIGNAL_DISTANCE_M) continue
      matchedReportIds.add(report.report_id)
      nearbyEffective += report.effective_reports
      strongestConfidence = bumpConfidence(strongestConfidence, report.confidence)
      categories.add(report.category)
    }
    if (nearbyEffective <= 0) return candidate

    const bonus = Math.min(2, nearbyEffective * 0.4)
    return {
      ...candidate,
      confidence: strongestConfidence,
      score: candidate.score + bonus,
      confidence_bonus: candidate.confidence_bonus + bonus,
      report_signal_count: nearbyEffective,
      inferred_signals: [
        ...candidate.inferred_signals,
        `Backed by ${nearbyEffective} effective community reports.`,
      ],
      reason:
        candidate.reason +
        ` Community signal: ${[...categories].slice(0, 3).join(", ")}.`,
    }
  })

  const syntheticCandidates: CandidateInternal[] = []
  for (const report of reportSignals) {
    if (matchedReportIds.has(report.report_id)) continue
    if (!reportCategoryIsHard(report.category)) continue
    if (baseComponentId === null) continue

    const syntheticNearestEdge = nearestEdgeIndex(
      report.coordinates,
      edges,
      edgeIndex,
      MAX_REPORT_SNAP_DISTANCE_M,
      true
    )

    const snappedReportNode = nearestGraphNode(
      report.coordinates,
      nodeIndex,
      nodeById,
      MAX_REPORT_SNAP_DISTANCE_M
    )
    const reportComponent =
      snappedReportNode && dsu.find(snappedReportNode.node_id) !== baseComponentId
        ? dsu.find(snappedReportNode.node_id)
        : null
    if (reportComponent === null || !snappedReportNode) continue
    const snappedNode = nodeById.get(snappedReportNode.node_id)
    if (!snappedNode) continue
    const snappedEdge =
      syntheticNearestEdge !== null ? edges[syntheticNearestEdge.edge_index] : undefined
    const snappedCoordinates: Coord = snappedEdge
      ? snappedEdge.mid_coord
      : [snappedNode.lon, snappedNode.lat]
    const blockedMeters = snappedEdge?.length_m ?? 30
    const locationLabel =
      snappedEdge?.location_label ??
      `${snappedCoordinates[1].toFixed(5)}, ${snappedCoordinates[0].toFixed(5)}`

    const otherStats = componentStats.get(reportComponent)
    if (!otherStats) continue

    const postOpportunity =
      snappedPois > 0 ? (100 * (baseReachablePois + otherStats.poi_count)) / snappedPois : 50
    const postGeneral = baselineNetwork.network_accessibility_score * 0.7 + postOpportunity * 0.3
    const deltaOas = postOpportunity - baselineOpportunityScore
    const deltaGeneral = postGeneral - baselineGeneralScore
    const confidenceBoost =
      confidenceBonus(report.confidence) + Math.min(1.2, report.effective_reports * 0.2)
    const fixPenalty = blockerFixCostPenalty("report")
    const score = deltaGeneral * 3 + otherStats.length_m / 750 + confidenceBoost - fixPenalty

    syntheticCandidates.push({
      blocker_id: `blk-report-${report.report_id}`,
      barrier_id: `blk-report-${report.report_id}`,
      blocker_type: "report",
      name: "Reported accessibility blocker",
      score,
      unlock_m: otherStats.length_m,
      blocked_m: blockedMeters,
      distance_m: haversineMeters(anchorPoint, snappedCoordinates),
      delta_nas_points: 0,
      delta_oas_points: deltaOas,
      delta_general_points: deltaGeneral,
      baseline_general_index: baselineGeneralScore,
      post_fix_general_index: postGeneral,
      unlocked_poi_count: otherStats.poi_count,
      unlocked_destination_counts: cloneCounts(otherStats.destination_counts),
      unlocked_component_id: reportComponent,
      confidence: report.confidence,
      osm_id: "N/A",
      reports_count: report.reports_count,
      renouncements: report.renouncements,
      report_ids: [report.report_id],
      tags: { report_category: report.category },
      inferred_signals: [`Community report category: ${report.category}.`],
      report_signal_count: report.effective_reports,
      confidence_bonus: confidenceBoost,
      fix_cost_penalty: fixPenalty,
      reason: `Community reports indicate a hard blocker disconnecting ${Math.round(
        otherStats.length_m
      )} m and ${otherStats.poi_count} destinations.`,
      grouped_component_key: `${baseComponentId}->${reportComponent}`,
      location_label: locationLabel,
      lat: snappedCoordinates[1],
      lon: snappedCoordinates[0],
    })
  }

  const grouped = new Map<string, CandidateInternal>()
  for (const candidate of [...candidatesWithReports, ...syntheticCandidates]) {
    const current = grouped.get(candidate.grouped_component_key)
    if (!current || candidate.score > current.score) {
      grouped.set(candidate.grouped_component_key, candidate)
    }
  }

  const rankedCandidates = [...grouped.values()]
    .sort((left, right) => right.score - left.score || right.unlock_m - left.unlock_m)
    .slice(0, 240)
  const rankings = rankedCandidates.map(toPublicCandidate)

  const barriersGeojson: FeatureCollection<Point> = {
    type: "FeatureCollection",
    features: rankings.map((candidate) =>
      pointFeature([candidate.lon, candidate.lat], {
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
      })
    ),
  }

  const streamsGeojson: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: edges.map((edge) =>
      lineFeature([edge.from_coord, edge.to_coord], {
        edge_id: edge.edge_id,
        way_id: edge.way_id,
        status: edge.classification.status,
        blocker_type: edge.classification.blocker_type ?? "pass",
        quality_score: edge.classification.quality_score,
      })
    ),
  }

  const accessibleGeojson: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: edges
      .filter((edge) => edge.classification.status === "PASS")
      .map((edge) => {
        const componentId = dsu.find(edge.from)
        return lineFeature([edge.from_coord, edge.to_coord], {
          edge_id: edge.edge_id,
          way_id: edge.way_id,
          status: "PASS",
          quality_score: edge.classification.quality_score,
          component_id: componentId,
          is_base_component: baseComponentId !== null && componentId === baseComponentId,
        })
      }),
  }

  const blockedSegmentsGeojson: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: blockedSegmentsFeatures,
  }

  const scoreGridGeojson = buildScoreGridGeojson(bbox, edges)
  const passEdges = edges.filter((edge) => edge.classification.status === "PASS").length
  const limitedEdges = edges.filter((edge) => edge.classification.status === "LIMITED").length
  const blockedEdges = edges.filter((edge) => edge.classification.status === "BLOCKED").length

  const calculationMethod = ANALYSIS_CALCULATION_METHOD

  return {
    payload: {
      streams_geojson: streamsGeojson,
      accessible_streams_geojson: accessibleGeojson,
      blocked_segments_geojson: blockedSegmentsGeojson,
      barriers_geojson: barriersGeojson,
      pois_geojson,
      score_grid_geojson: scoreGridGeojson,
      rankings,
      meta: {
        bbox,
        warnings,
        calculation_method: calculationMethod,
        overpass_query_version,
        profile_assumptions: [
          "Undirected pedestrian connectivity approximation",
          "Strict wheelchair profile for hard blockers",
          "POIs counted only when snapped to the pedestrian network",
          "General score combines network traversability and destination reach",
        ],
        accessibility: {
          network_accessibility_score: Number(
            baselineNetwork.network_accessibility_score.toFixed(3)
          ),
          opportunity_accessibility_score: Number(baselineOpportunityScore.toFixed(3)),
          general_accessibility_index: Number(baselineGeneralScore.toFixed(3)),
          metrics: {
            coverage_ratio: Number(baselineNetwork.coverage_ratio.toFixed(4)),
            continuity_ratio: Number(baselineNetwork.continuity_ratio.toFixed(4)),
            quality_ratio: Number(baselineNetwork.quality_ratio.toFixed(4)),
            blocker_pressure_ratio: Number(baselineNetwork.blocker_pressure_ratio.toFixed(4)),
          },
        },
        counts: {
          pedestrian_ways: pedestrianWays.length,
          stream_ways: pedestrianWays.length,
          graph_nodes: graphNodeIds.size,
          pass_edges: passEdges,
          limited_edges: limitedEdges,
          blocked_edges: blockedEdges,
          blockers: rankings.length,
          barriers: rankings.length,
          components: componentStats.size,
          snapped_pois: snappedPois,
          unsnapped_pois: unsnappedPois,
          reports_used: matchedReportIds.size + syntheticCandidates.length,
        },
        debug: {
          anchor_lon: Number(anchorPoint[0].toFixed(6)),
          anchor_lat: Number(anchorPoint[1].toFixed(6)),
          anchor_snap_distance_m: anchorSnap ? Number(anchorSnap.distance_m.toFixed(2)) : -1,
          anchor_poi_id: options.anchor_poi_id ?? "",
          raw_candidates: rawCandidates.length,
          grouped_candidates: grouped.size,
          synthetic_candidates: syntheticCandidates.length,
          reports_in_bbox: reportSignals.length,
          total_network_m: Math.round(totalLengthM),
          pass_network_m: Math.round(passLengthM),
          limited_network_m: Math.round(limitedLengthM),
          blocked_network_m: Math.round(blockedLengthM),
        },
      },
    },
  }
}
