import type { FeatureCollection, Point } from "geojson"
import type { PoiFeatureProperties } from "../types"
import type { OverpassElement, OverpassNode, OverpassResponse, OverpassWay } from "./overpass"

type Coord = [number, number]

const HEALTHCARE_AMENITIES = new Set(["hospital", "clinic", "doctors", "pharmacy"])
const ESSENTIAL_AMENITIES = new Set(["toilets", "drinking_water", "bench"])

function asTags(tags?: Record<string, string>) {
  return tags ?? {}
}

function hasPoiSignal(tags: Record<string, string>) {
  if (typeof tags.amenity === "string") {
    if (HEALTHCARE_AMENITIES.has(tags.amenity)) return true
    if (ESSENTIAL_AMENITIES.has(tags.amenity)) return true
  }
  if (typeof tags.healthcare === "string") return true
  if (tags.emergency === "ambulance_station") return true
  if (typeof tags.wheelchair === "string") return true
  return false
}

function deriveKind(tags: Record<string, string>) {
  if (typeof tags.amenity === "string") {
    if (HEALTHCARE_AMENITIES.has(tags.amenity) || ESSENTIAL_AMENITIES.has(tags.amenity)) {
      return tags.amenity
    }
  }
  if (typeof tags.healthcare === "string") {
    return tags.healthcare.trim().length > 0 ? tags.healthcare : "healthcare"
  }
  if (tags.emergency === "ambulance_station") return "ambulance_station"
  if (typeof tags.wheelchair === "string") return "wheelchair_tagged_place"
  return "poi"
}

function deriveTheme(kind: string): "healthcare" | "essential" {
  if (
    kind === "hospital" ||
    kind === "clinic" ||
    kind === "doctors" ||
    kind === "pharmacy" ||
    kind === "ambulance_station" ||
    kind === "healthcare" ||
    kind.startsWith("healthcare")
  ) {
    return "healthcare"
  }
  return "essential"
}

function tagsSummary(tags: Record<string, string>) {
  const keepKeys = [
    "amenity",
    "healthcare",
    "emergency",
    "name",
    "wheelchair",
    "toilets:wheelchair",
    "surface",
    "smoothness",
    "incline",
  ]
  const summary: Record<string, string> = {}
  for (const key of keepKeys) {
    const value = tags[key]
    if (typeof value === "string" && value.trim().length > 0) {
      summary[key] = value
    }
  }
  return summary
}

function centroid(points: Coord[]): Coord | null {
  if (points.length === 0) return null
  let lonSum = 0
  let latSum = 0
  for (const [lon, lat] of points) {
    lonSum += lon
    latSum += lat
  }
  return [lonSum / points.length, latSum / points.length]
}

function buildWayCentroid(way: OverpassWay, nodesById: Map<number, OverpassNode>): Coord | null {
  const coords = way.nodes
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is OverpassNode => Boolean(node))
    .map((node) => [node.lon, node.lat] as Coord)
  return centroid(coords)
}

function pointFeature(coord: Coord, properties: PoiFeatureProperties) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "Point" as const,
      coordinates: coord,
    },
    properties,
  }
}

function toPoiProperties(
  osmType: "node" | "way",
  osmId: number,
  tags: Record<string, string>
): PoiFeatureProperties {
  const kind = deriveKind(tags)
  return {
    poi_id: `${osmType}/${osmId}`,
    osm_type: osmType,
    osm_id: osmId,
    name: tags.name,
    kind,
    theme: deriveTheme(kind),
    wheelchair: tags.wheelchair,
    toilets_wheelchair: tags["toilets:wheelchair"],
    tags_summary: tagsSummary(tags),
  }
}

export function overpassToPoisGeojson(
  response: OverpassResponse
): FeatureCollection<Point, PoiFeatureProperties> {
  const nodesById = new Map<number, OverpassNode>()
  for (const element of response.elements as OverpassElement[]) {
    if (element.type === "node") {
      const node = element as OverpassNode
      nodesById.set(node.id, node)
    }
  }

  const featuresById = new Map<string, ReturnType<typeof pointFeature>>()

  for (const element of response.elements as OverpassElement[]) {
    if (element.type === "node") {
      const node = element as OverpassNode
      const tags = asTags(node.tags)
      if (!hasPoiSignal(tags)) continue
      const props = toPoiProperties("node", node.id, tags)
      featuresById.set(props.poi_id, pointFeature([node.lon, node.lat], props))
      continue
    }

    if (element.type === "way") {
      const way = element as OverpassWay
      const tags = asTags(way.tags)
      if (!hasPoiSignal(tags)) continue
      const center = buildWayCentroid(way, nodesById)
      if (!center) continue
      const props = toPoiProperties("way", way.id, tags)
      featuresById.set(props.poi_id, pointFeature(center, props))
    }
  }

  return {
    type: "FeatureCollection",
    features: [...featuresById.values()],
  }
}
