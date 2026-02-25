import type { BBox } from "@/lib/api/client"

export function bboxFromCenterRadiusKm(center: [number, number], radiusKm: number): BBox {
  const [lon, lat] = center
  const latRadians = (lat * Math.PI) / 180
  const dLat = radiusKm / 111.32
  const dLon = radiusKm / (111.32 * Math.max(0.2, Math.cos(latRadians)))
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}
