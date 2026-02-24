"use client"

import type { Map as MapLibreMap } from "maplibre-gl"
import { DEFAULT_CENTER, DEFAULT_ZOOM, MAP_STYLES } from "@/lib/map/config"

export type MapType = "standard" | "hybrid" | "satellite"

type MapLibreModule = typeof import("maplibre-gl")

const MAP_MODE_TO_STYLE: Record<MapType, keyof typeof MAP_STYLES> = {
  standard: "street",
  hybrid: "hybrid",
  satellite: "satellite",
}

function getStyleForMode(mode: MapType) {
  return MAP_STYLES[MAP_MODE_TO_STYLE[mode]]
}

export interface MapController {
  map: MapLibreMap
  setMapMode: (nextMode: MapType) => boolean
  getMapMode: () => MapType
}

export async function createMapController(initialMode: MapType): Promise<MapController> {
  const moduleValue = await import("maplibre-gl")
  const maplibregl = (moduleValue.default ?? moduleValue) as MapLibreModule

  const supported = (maplibregl as unknown as { supported?: () => boolean }).supported
  if (typeof supported === "function" && !supported()) {
    throw new Error("MapLibre requires WebGL support.")
  }

  let mapMode: MapType = initialMode
  const map = new maplibregl.Map({
    container: "map",
    style: getStyleForMode(mapMode),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: { compact: true },
  })

  map.touchZoomRotate.disableRotation()

  function setMapMode(nextMode: MapType): boolean {
    if (nextMode === mapMode) {
      return true
    }
    mapMode = nextMode
    map.setStyle(getStyleForMode(nextMode))
    return true
  }

  function getMapMode() {
    return mapMode
  }

  return { map, setMapMode, getMapMode }
}
