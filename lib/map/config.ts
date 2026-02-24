import type { StyleSpecification } from "maplibre-gl"

type MapMode = "street" | "hybrid" | "satellite"

export const DEFAULT_CENTER: [number, number] = [-122.3321, 47.6062]
export const DEFAULT_ZOOM = 11

type MapStyle = string | StyleSpecification

function buildRasterStyle(
  id: string,
  tileUrls: string[],
  attribution: string,
  tileSize = 256
): StyleSpecification {
  return {
    version: 8,
    name: id,
    sources: {
      basemap: {
        type: "raster",
        tiles: tileUrls,
        tileSize,
        attribution,
      },
    },
    layers: [
      {
        id: `${id}-raster-layer`,
        type: "raster",
        source: "basemap",
      },
    ],
  }
}

const envStandard = process.env.NEXT_PUBLIC_MAP_STYLE_STANDARD?.trim()
const envHybrid = process.env.NEXT_PUBLIC_MAP_STYLE_HYBRID?.trim()
const envSatellite = process.env.NEXT_PUBLIC_MAP_STYLE_SATELLITE?.trim()

export const MAP_STYLES: Record<MapMode, MapStyle> = {
  street:
    envStandard ||
    buildRasterStyle(
      "street",
      [
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      ],
      "(C) OpenStreetMap contributors"
    ),
  hybrid:
    envHybrid || "https://tiles.openfreemap.org/styles/liberty",
  satellite:
    envSatellite ||
    buildRasterStyle(
      "satellite",
      [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      "Tiles (C) Esri"
    ),
}
