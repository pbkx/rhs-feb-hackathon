import type { BBox } from "../types"

const EARTH_RADIUS_M = 6_371_000

function toRadians(value: number) {
  return (value * Math.PI) / 180
}

export function haversineMeters(a: [number, number], b: [number, number]) {
  const [lon1, lat1] = a
  const [lon2, lat2] = b
  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)
  const sLat1 = toRadians(lat1)
  const sLat2 = toRadians(lat2)
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(sLat1) * Math.cos(sLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export function bboxCenter(bbox: BBox): [number, number] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2]
}

export function pointInBBox(point: [number, number], bbox: BBox): boolean {
  const [lon, lat] = point
  const [minLon, minLat, maxLon, maxLat] = bbox
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat
}

export function normalizeBBox(bbox: BBox): BBox {
  const [aLon, aLat, bLon, bLat] = bbox
  return [Math.min(aLon, bLon), Math.min(aLat, bLat), Math.max(aLon, bLon), Math.max(aLat, bLat)]
}

export function bboxAreaDegrees(bbox: BBox): number {
  const [minLon, minLat, maxLon, maxLat] = bbox
  return Math.abs(maxLon - minLon) * Math.abs(maxLat - minLat)
}
