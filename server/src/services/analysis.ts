import type { Feature, FeatureCollection, GeoJsonProperties, LineString, Point } from "geojson"
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
}

interface PedestrianEdge {
  edge_id: string
  way_id: number
  from: number
  to: number
  from_coord: Coord
  to_coord: Coord
  length_m: number
  tags: Record<string, string>
  classification: EdgeClassification
  location_label: string
}

interface ComponentStats {
  length_m: number
  healthcare_score: number
  essentials_score: number
  healthcare_counts: Record<string, number>
  essentials_counts: Record<string, number>
  poi_count: number
}

interface CandidateInternal {
  blocker_id: string
  barrier_id: string
  blocker_type: AccessBlockerType
  name: string
  score: number
  unlock_km: number
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
  blocked_length_m: number
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
  coordinates: Coord
}

function asTags(tags?: Record<string, string>) {
  return tags ?? {}
}

function lineFeature(coords: Coord[], properties: GeoJsonProperties): Feature<LineString> {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: coords,
    },
    properties,
  }
}

function pointFeature(point: Coord, properties: GeoJsonProperties): Feature<Point> {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: point,
    },
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
      return 0.9
    case "raised_kerb":
      return 0.6
    case "steep_incline":
      return 0.7
    case "rough_surface":
      return 0.5
    case "wheelchair_limited":
      return 0.45
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
    }
  }
  if (tags.wheelchair === "no") {
    return {
      status: "BLOCKED",
      blocker_type: "wheelchair_no",
      confidence: "high",
      inferred_signals: ["Tagged wheelchair=no."],
    }
  }
  if (BLOCKED_ACCESS_VALUES.has(tags.access ?? "") || BLOCKED_ACCESS_VALUES.has(tags.foot ?? "")) {
    return {
      status: "BLOCKED",
      blocker_type: "access_no",
      confidence: "high",
      inferred_signals: ["Tagged access/foot restriction blocks pedestrian use."],
    }
  }
  if (hasRaisedKerbEndpoint) {
    return {
      status: "BLOCKED",
      blocker_type: "raised_kerb",
      confidence: "high",
      inferred_signals: ["Connected to kerb=raised crossing node."],
    }
  }
  if (tags.wheelchair === "limited") {
    return {
      status: "LIMITED",
      blocker_type: "wheelchair_limited",
      confidence: "high",
      inferred_signals: ["Tagged wheelchair=limited."],
    }
  }
  const inclinePct = parseInclineTag(tags.incline)
  if (inclinePct !== null && inclinePct >= 8) {
    return {
      status: "LIMITED",
      blocker_type: "steep_incline",
      confidence: "medium",
      inferred_signals: [`Incline tag suggests ~${inclinePct.toFixed(1)}% slope.`],
    }
  }
  if (typeof tags.surface === "string" && ROUGH_SURFACES.has(tags.surface)) {
    return {
      status: "LIMITED",
      blocker_type: "rough_surface",
      confidence: "medium",
      inferred_signals: [`Surface tagged ${tags.surface}.`],
    }
  }
  if (typeof tags.smoothness === "string" && POOR_SMOOTHNESS.has(tags.smoothness)) {
    return {
      status: "LIMITED",
      blocker_type: "rough_surface",
      confidence: "medium",
      inferred_signals: [`Smoothness tagged ${tags.smoothness}.`],
    }
  }
  return {
    status: "PASS",
    blocker_type: null,
    confidence: "medium",
    inferred_signals: [],
  }
}

function incrementCount(target: Record<string, number>, key: string, amount = 1) {
  target[key] = (target[key] ?? 0) + amount
}

function healthcareWeight(kind: string) {
  if (kind === "hospital") return 5
  if (kind === "clinic" || kind === "doctors") return 3
  if (kind === "pharmacy") return 2
  return 1
}

function essentialWeight(poi: PoiFeatureProperties) {
  if (poi.kind === "toilets") {
    if (poi.toilets_wheelchair === "yes" || poi.wheelchair === "yes") return 2
    return 1
  }
  if (poi.kind === "drinking_water") return 1
  if (poi.kind === "bench") return 1
  return 0.5
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

function componentImportance(stats: ComponentStats) {
  return stats.length_m / 1000 + 2.5 * stats.healthcare_score + 0.5 * stats.essentials_score
}

function summarizeUnlockedServices(
  healthcareCounts: Record<string, number>,
  essentialCounts: Record<string, number>
) {
  const parts: string[] = []
  const healthcareSummary = Object.entries(healthcareCounts)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([kind, count]) => `${count} ${kind}`)
  if (healthcareSummary.length > 0) {
    parts.push(`healthcare: ${healthcareSummary.join(", ")}`)
  }
  const essentialSummary = Object.entries(essentialCounts)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([kind, count]) => `${count} ${kind}`)
  if (essentialSummary.length > 0) {
    parts.push(`essentials: ${essentialSummary.join(", ")}`)
  }
  return parts.length > 0 ? parts.join(" | ") : "no mapped services"
}

function candidatePreferred(next: CandidateInternal, current: CandidateInternal) {
  const confidenceRank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }
  if (confidenceRank[next.confidence] !== confidenceRank[current.confidence]) {
    return confidenceRank[next.confidence] > confidenceRank[current.confidence]
  }
  if (next.report_signal_count !== current.report_signal_count) {
    return next.report_signal_count > current.report_signal_count
  }
  if (next.fix_cost_penalty !== current.fix_cost_penalty) {
    return next.fix_cost_penalty < current.fix_cost_penalty
  }
  if (next.blocked_length_m !== current.blocked_length_m) {
    return next.blocked_length_m < current.blocked_length_m
  }
  if (next.distance_km !== current.distance_km) {
    return next.distance_km < current.distance_km
  }
  return next.blocker_id < current.blocker_id
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
    healthcare_score: 0,
    essentials_score: 0,
    healthcare_counts: {},
    essentials_counts: {},
    poi_count: 0,
  }
}

function toPublicCandidate(candidate: CandidateInternal): AccessBlockerCandidate {
  return {
    blocker_id: candidate.blocker_id,
    barrier_id: candidate.barrier_id,
    blocker_type: candidate.blocker_type,
    name: candidate.name,
    score: Number(candidate.score.toFixed(3)),
    unlock_km: Number(candidate.unlock_km.toFixed(2)),
    gain_km: Number(candidate.unlock_km.toFixed(2)),
    blocked_km: Number(candidate.blocked_km.toFixed(2)),
    unlocked_healthcare_score: Number(candidate.unlocked_healthcare_score.toFixed(2)),
    unlocked_essentials_score: Number(candidate.unlocked_essentials_score.toFixed(2)),
    unlocked_healthcare_counts: cloneCounts(candidate.unlocked_healthcare_counts),
    unlocked_essentials_counts: cloneCounts(candidate.unlocked_essentials_counts),
    confidence: candidate.confidence,
    distance_km: Number(candidate.distance_km.toFixed(2)),
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
    const nodes = way.nodes
    if (!Array.isArray(nodes) || nodes.length < 2) continue
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const fromId = nodes[index]
      const toId = nodes[index + 1]
      const fromNode = nodeById.get(fromId)
      const toNode = nodeById.get(toId)
      if (!fromNode || !toNode) continue

      graphNodeIds.add(fromId)
      graphNodeIds.add(toId)
      nodeIndex.insertPoint([fromNode.lon, fromNode.lat], fromId)
      nodeIndex.insertPoint([toNode.lon, toNode.lat], toId)

      const hasRaisedKerbEndpoint = raisedKerbNodeIds.has(fromId) || raisedKerbNodeIds.has(toId)
      const classification = classifyPedestrianEdgeAccessibility(tags, hasRaisedKerbEndpoint)
      const fromCoord: Coord = [fromNode.lon, fromNode.lat]
      const toCoord: Coord = [toNode.lon, toNode.lat]

      edges.push({
        edge_id: `${way.id}-${index}`,
        way_id: way.id,
        from: fromId,
        to: toId,
        from_coord: fromCoord,
        to_coord: toCoord,
        length_m: haversineMeters(fromCoord, toCoord),
        tags,
        classification,
        location_label: formatLocationLabel(
          tags,
          (fromCoord[0] + toCoord[0]) / 2,
          (fromCoord[1] + toCoord[1]) / 2
        ),
      })
    }
  }

  if (graphNodeIds.size > MAX_GRAPH_NODES || edges.length > MAX_GRAPH_EDGES) {
    throw new Error("Area too large for analysis. Click a POI in a denser neighborhood or zoom in first.")
  }

  if (edges.length === 0) {
    warnings.push("No mapped pedestrian network found in this area.")
  }

  const dsu = new DisjointSet()
  for (const nodeId of graphNodeIds) {
    dsu.makeSet(nodeId)
  }
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
  for (const edge of edges) {
    if (edge.classification.status !== "PASS") continue
    const root = dsu.find(edge.from)
    const stats = ensureComponent(root)
    stats.length_m += edge.length_m
  }

  const rawPoisGeojson = overpassToPoisGeojson(response)
  const snappedPoiFeatures: Feature<Point, PoiFeatureProperties>[] = []
  let snappedPois = 0
  let unsnappedPois = 0
  for (const feature of rawPoisGeojson.features) {
    const geometry = feature.geometry
    if (!geometry || geometry.type !== "Point") continue
    const coordinates = geometry.coordinates as Coord
    const props = feature.properties
    if (!props) continue

    const snapped = nearestGraphNode(coordinates, nodeIndex, nodeById, MAX_POI_SNAP_DISTANCE_M)
    const enrichedProps: PoiFeatureProperties = {
      ...props,
      snapped_node_id: snapped?.node_id ?? null,
      snap_distance_m: snapped ? Number(snapped.distance_m.toFixed(2)) : null,
    }

    if (snapped) {
      snappedPois += 1
      const componentId = dsu.find(snapped.node_id)
      const stats = ensureComponent(componentId)
      stats.poi_count += 1
      if (props.theme === "healthcare") {
        const weight = healthcareWeight(props.kind)
        stats.healthcare_score += weight
        incrementCount(stats.healthcare_counts, props.kind, 1)
      } else {
        const weight = essentialWeight(props)
        stats.essentials_score += weight
        incrementCount(stats.essentials_counts, props.kind, 1)
      }
    } else {
      unsnappedPois += 1
    }

    snappedPoiFeatures.push({
      ...feature,
      properties: enrichedProps,
    })
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
        bestComponent = componentId
        bestLength = stats.length_m
      }
    }
    baseComponentId = bestComponent
    warnings.push("Could not snap anchor point; using the largest reachable component as fallback.")
  }

  const pickBestNonBaseComponent = () => {
    let bestComponent: number | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const [componentId, stats] of componentStats.entries()) {
      if (baseComponentId !== null && componentId === baseComponentId) continue
      const score = componentImportance(stats)
      if (score > bestScore) {
        bestScore = score
        bestComponent = componentId
      }
    }
    return bestComponent
  }

  const rawCandidates: CandidateInternal[] = []
  const blockedSegmentsFeatures: Feature<LineString>[] = []

  for (const edge of edges) {
    const status = edge.classification.status
    if (status === "PASS") continue

    blockedSegmentsFeatures.push(
      lineFeature([edge.from_coord, edge.to_coord], {
        edge_id: edge.edge_id,
        way_id: edge.way_id,
        blocker_type: edge.classification.blocker_type ?? "other",
        status,
      })
    )

    const leftComponent = dsu.find(edge.from)
    const rightComponent = dsu.find(edge.to)
    if (leftComponent === rightComponent) continue

    let otherComponent: number | null = null
    let groupedKey = `${leftComponent}<->${rightComponent}`
    if (baseComponentId !== null) {
      if (leftComponent === baseComponentId && rightComponent !== baseComponentId) {
        otherComponent = rightComponent
      } else if (rightComponent === baseComponentId && leftComponent !== baseComponentId) {
        otherComponent = leftComponent
      } else {
        continue
      }
      groupedKey = `${baseComponentId}->${otherComponent}`
    } else {
      const leftScore = componentImportance(ensureComponent(leftComponent))
      const rightScore = componentImportance(ensureComponent(rightComponent))
      otherComponent = leftScore >= rightScore ? rightComponent : leftComponent
    }

    const otherStats = otherComponent !== null ? componentStats.get(otherComponent) : null
    if (!otherStats) continue
    const unlockKm = otherStats.length_m / 1000
    if (unlockKm <= 0 && otherStats.healthcare_score <= 0 && otherStats.essentials_score <= 0) continue

    const blockerType = edge.classification.blocker_type ?? "other"
    const midPoint: Coord = [
      (edge.from_coord[0] + edge.to_coord[0]) / 2,
      (edge.from_coord[1] + edge.to_coord[1]) / 2,
    ]
    const baseConfidenceBonus = confidenceBonus(edge.classification.confidence)
    const fixPenalty = blockerFixCostPenalty(blockerType)
    const score =
      unlockKm +
      2.5 * otherStats.healthcare_score +
      0.5 * otherStats.essentials_score +
      baseConfidenceBonus -
      fixPenalty

    rawCandidates.push({
      blocker_id: `blk-${edge.edge_id}`,
      barrier_id: `blk-${edge.edge_id}`,
      blocker_type: blockerType,
      name: kindLabel(blockerType),
      score,
      unlock_km: unlockKm,
      blocked_km: edge.length_m / 1000,
      unlocked_healthcare_score: otherStats.healthcare_score,
      unlocked_essentials_score: otherStats.essentials_score,
      unlocked_healthcare_counts: cloneCounts(otherStats.healthcare_counts),
      unlocked_essentials_counts: cloneCounts(otherStats.essentials_counts),
      confidence: edge.classification.confidence,
      distance_km: haversineMeters(anchorPoint, midPoint) / 1000,
      osm_id: `way/${edge.way_id}`,
      tags: edge.tags,
      inferred_signals: [...edge.classification.inferred_signals],
      report_signal_count: 0,
      confidence_bonus: baseConfidenceBonus,
      fix_cost_penalty: fixPenalty,
      reason: `Separates currently reachable network from ${summarizeUnlockedServices(
        otherStats.healthcare_counts,
        otherStats.essentials_counts
      )}.`,
      grouped_component_key: groupedKey,
      location_label: edge.location_label,
      lat: midPoint[1],
      lon: midPoint[0],
      blocked_length_m: edge.length_m,
    })
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
      coordinates: report.coordinates,
    }))

  const reportIndex = new SpatialHash<number>(0.015, 0.015)
  reportSignals.forEach((report, index) => {
    reportIndex.insertPoint(report.coordinates, index)
  })
  const matchedReportIds = new Set<string>()

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
    for (const reportIndexValue of nearbyIndexes) {
      const report = reportSignals[reportIndexValue]
      if (!report) continue
      const distance = haversineMeters(point, report.coordinates)
      if (distance > REPORT_SIGNAL_DISTANCE_M) continue
      matchedReportIds.add(report.report_id)
      nearbyEffective += report.effective_reports
      strongestConfidence = bumpConfidence(strongestConfidence, report.confidence)
      categories.add(report.category)
    }
    if (nearbyEffective <= 0) {
      return candidate
    }

    const reportBonus = Math.min(1.5, nearbyEffective * 0.25)
    return {
      ...candidate,
      confidence: strongestConfidence,
      score: candidate.score + reportBonus,
      confidence_bonus: candidate.confidence_bonus + reportBonus,
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
    const category = report.category.toLowerCase().trim()
    if (!HARD_REPORT_CATEGORIES.has(category)) continue

    let otherComponent: number | null = null
    const snappedReportNode = nearestGraphNode(
      report.coordinates,
      nodeIndex,
      nodeById,
      MAX_REPORT_SNAP_DISTANCE_M
    )
    if (snappedReportNode) {
      const reportComponent = dsu.find(snappedReportNode.node_id)
      if (baseComponentId !== null && reportComponent !== baseComponentId) {
        otherComponent = reportComponent
      }
    }
    if (otherComponent === null) {
      otherComponent = pickBestNonBaseComponent()
    }
    if (otherComponent === null) continue

    const otherStats = componentStats.get(otherComponent)
    if (!otherStats) continue
    if (baseComponentId !== null && otherComponent === baseComponentId) continue

    const reportConfidenceBonus =
      confidenceBonus(report.confidence) + Math.min(1.2, report.effective_reports * 0.2)
    const fixPenalty = blockerFixCostPenalty("report")
    const unlockKm = otherStats.length_m / 1000
    const score =
      unlockKm +
      2.5 * otherStats.healthcare_score +
      0.5 * otherStats.essentials_score +
      reportConfidenceBonus -
      fixPenalty

    const groupedKey =
      baseComponentId !== null ? `${baseComponentId}->${otherComponent}` : `synthetic->${otherComponent}`

    syntheticCandidates.push({
      blocker_id: `blk-report-${report.report_id}`,
      barrier_id: `blk-report-${report.report_id}`,
      blocker_type: "report",
      name: "Reported accessibility blocker",
      score,
      unlock_km: unlockKm,
      blocked_km: 0.03,
      unlocked_healthcare_score: otherStats.healthcare_score,
      unlocked_essentials_score: otherStats.essentials_score,
      unlocked_healthcare_counts: cloneCounts(otherStats.healthcare_counts),
      unlocked_essentials_counts: cloneCounts(otherStats.essentials_counts),
      confidence: report.confidence,
      distance_km: haversineMeters(anchorPoint, report.coordinates) / 1000,
      osm_id: `report/${report.report_id}`,
      tags: {
        report_category: report.category,
      },
      inferred_signals: [`Community report category: ${report.category}.`],
      report_signal_count: report.effective_reports,
      confidence_bonus: reportConfidenceBonus,
      fix_cost_penalty: fixPenalty,
      reason: `Report indicates a hard blocker near ${report.coordinates[1].toFixed(5)}, ${report.coordinates[0].toFixed(5)} separating reachable paths from ${summarizeUnlockedServices(
        otherStats.healthcare_counts,
        otherStats.essentials_counts
      )}.`,
      grouped_component_key: groupedKey,
      location_label: `${report.coordinates[1].toFixed(5)}, ${report.coordinates[0].toFixed(5)}`,
      lat: report.coordinates[1],
      lon: report.coordinates[0],
      blocked_length_m: 30,
    })
  }

  const grouped = new Map<string, CandidateInternal>()
  for (const candidate of [...candidatesWithReports, ...syntheticCandidates]) {
    const existing = grouped.get(candidate.grouped_component_key)
    if (!existing || candidatePreferred(candidate, existing)) {
      grouped.set(candidate.grouped_component_key, candidate)
    }
  }

  const rankedCandidates = [...grouped.values()]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      if (right.unlock_km !== left.unlock_km) return right.unlock_km - left.unlock_km
      return left.distance_km - right.distance_km
    })
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
        gain_km: candidate.gain_km,
        unlock_km: candidate.unlock_km,
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
      })
    ),
  }

  const accessibleGeojson: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: edges
      .filter((edge) => edge.classification.status === "PASS")
      .map((edge) =>
        lineFeature([edge.from_coord, edge.to_coord], {
          edge_id: edge.edge_id,
          way_id: edge.way_id,
          status: "PASS",
        })
      ),
  }

  const blockedSegmentsGeojson: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: blockedSegmentsFeatures,
  }

  const passEdges = edges.filter((edge) => edge.classification.status === "PASS").length
  const limitedEdges = edges.filter((edge) => edge.classification.status === "LIMITED").length
  const blockedEdges = edges.filter((edge) => edge.classification.status === "BLOCKED").length

  const calculationMethod =
    "AccessBlocker Radar uses PASS-edge Union-Find components and ranks blockers by unlocked path distance, healthcare reach, essential reach, and confidence signals."

  return {
    payload: {
      streams_geojson: streamsGeojson,
      accessible_streams_geojson: accessibleGeojson,
      blocked_segments_geojson: blockedSegmentsGeojson,
      barriers_geojson: barriersGeojson,
      pois_geojson,
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
        ],
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
        },
      },
    },
  }
}
