"use client"

import type { FeatureCollection, LineString, Point } from "geojson"
import type { GeoJSONSource, Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl"
import type { AnalyzeResultPayload, BBox, ReportRecord } from "@/lib/api/client"
import { createMapController, type MapController, type MapType } from "@/lib/map/map-controller"

const SOURCE_STREAMS = "analysis-streams-src"
const SOURCE_ACCESSIBLE = "analysis-accessible-src"
const SOURCE_BARRIERS = "analysis-barriers-src"
const SOURCE_BBOX = "selection-bbox-src"
const SOURCE_REPORTS = "reports-src"
const SOURCE_USER_LOCATION = "user-location-src"
const SOURCE_USER_ACCURACY = "user-accuracy-src"

const LAYER_STREAMS = "analysis-streams-layer"
const LAYER_STREAM_DIRECTION = "analysis-stream-direction-layer"
const LAYER_ACCESSIBLE = "analysis-accessible-layer"
const LAYER_BARRIERS_GLOW = "analysis-barriers-glow-layer"
const LAYER_BARRIERS = "analysis-barriers-layer"
const LAYER_BARRIERS_ICON = "analysis-barriers-icon-layer"
const LAYER_BARRIERS_SELECTED = "analysis-barriers-selected-layer"
const LAYER_BBOX_FILL = "selection-bbox-fill-layer"
const LAYER_BBOX_LINE = "selection-bbox-line-layer"
const LAYER_REPORTS = "reports-layer"
const LAYER_USER_LOCATION_HALO = "user-location-halo-layer"
const LAYER_USER_LOCATION = "user-location-layer"
const LAYER_USER_ACCURACY_BASE = "user-accuracy-base-layer"
const LAYER_USER_ACCURACY = "user-accuracy-layer"
const LAYER_USER_ACCURACY_STROKE = "user-accuracy-stroke-layer"

const emptyPointCollection = (): FeatureCollection<Point> => ({
  type: "FeatureCollection",
  features: [],
})

const emptyLineCollection = (): FeatureCollection<LineString> => ({
  type: "FeatureCollection",
  features: [],
})

interface SharedBarrierPreview {
  id: string
  coordinates: [number, number]
  type: "dam" | "weir" | "waterfall"
  name: string
}

class MapManager {
  private map: MapLibreMap | null = null
  private mapController: MapController | null = null
  private initPromise: Promise<MapLibreMap> | null = null
  private resizeObserver: ResizeObserver | null = null

  private activeMapType: MapType = "standard"
  private layerVisibility: Record<string, boolean> = {
    streams: true,
    accessible: true,
    barriers: true,
    reports: true,
  }

  private selectedBarrierId: string | null = null
  private selectedReportId: string | null = null
  private bbox: BBox | null = null
  private bboxDisplayMode: "fill" | "outline" = "fill"
  private reportMarker: [number, number] | null = null
  private userLocation: [number, number] | null = null
  private userAccuracyMeters: number | null = null
  private userLocationMarker: MapLibreMarker | null = null
  private reportDraftMarker: MapLibreMarker | null = null
  private reportDraftMarkerElement: HTMLElement | null = null
  private barrierMarkers = new Map<string, MapLibreMarker>()
  private barrierMarkerElements = new Map<string, HTMLElement>()
  private sharedBarrierPreview: SharedBarrierPreview | null = null
  private sharedBarrierMarker: MapLibreMarker | null = null
  private sharedBarrierMarkerElement: HTMLElement | null = null
  private reportMarkers = new Map<string, MapLibreMarker>()
  private reportMarkerElements = new Map<string, HTMLElement>()

  private analysisData: {
    streams_geojson: FeatureCollection<LineString>
    accessible_streams_geojson: FeatureCollection<LineString>
    barriers_geojson: FeatureCollection<Point>
  } = {
    streams_geojson: emptyLineCollection(),
    accessible_streams_geojson: emptyLineCollection(),
    barriers_geojson: emptyPointCollection(),
  }

  private reportsData: ReportRecord[] = []

  private barrierClickHandler: ((barrierId: string) => void) | null = null
  private reportClickHandler: ((reportId: string) => void) | null = null
  private reportPickActive = false
  private reportPickHandler: ((coords: [number, number]) => void) | null = null

  private viewListeners = new Set<(bbox: BBox) => void>()
  
  private buildAccuracyPolygon(center: [number, number], radiusMeters: number, segments = 48): FeatureCollection {
    const [lon, lat] = center
    const latFactor = 110540
    const lonFactor = 111320 * Math.cos((lat * Math.PI) / 180)
    const coordinates: [number, number][] = []

    for (let index = 0; index <= segments; index += 1) {
      const theta = (index / segments) * Math.PI * 2
      const dx = (radiusMeters * Math.cos(theta)) / Math.max(1, lonFactor)
      const dy = (radiusMeters * Math.sin(theta)) / latFactor
      coordinates.push([lon + dx, lat + dy])
    }

    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [coordinates],
          },
        },
      ],
    }
  }

  private currentSourceData(sourceId: string): FeatureCollection | null {
    if (sourceId === SOURCE_STREAMS) return this.analysisData.streams_geojson
    if (sourceId === SOURCE_ACCESSIBLE) return this.analysisData.accessible_streams_geojson
    if (sourceId === SOURCE_BARRIERS) return this.analysisData.barriers_geojson
    if (sourceId === SOURCE_BBOX) {
      return this.bbox ? this.bboxPolygonFeature(this.bbox) : { type: "FeatureCollection", features: [] }
    }
    if (sourceId === SOURCE_REPORTS) {
      return {
        type: "FeatureCollection",
        features: this.reportsData
          .filter(
            (report): report is ReportRecord & { coordinates: [number, number] } =>
              !report.barrier_id &&
              Array.isArray(report.coordinates) &&
              report.coordinates.length === 2
          )
          .map((report) => ({
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: report.coordinates },
            properties: {
              report_id: report.report_id,
              category: report.category || "Report",
              created_at: report.created_at,
            },
          })),
      }
    }
    if (sourceId === SOURCE_USER_LOCATION) {
      return this.userLocation
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: this.userLocation },
                properties: {},
              },
            ],
          }
        : { type: "FeatureCollection", features: [] }
    }
    if (sourceId === SOURCE_USER_ACCURACY) {
      if (!this.userLocation || !this.userAccuracyMeters || this.userAccuracyMeters <= 0) {
        return { type: "FeatureCollection", features: [] }
      }
      return this.buildAccuracyPolygon(this.userLocation, this.userAccuracyMeters)
    }
    return null
  }

  async initialize(): Promise<MapLibreMap> {
    if (typeof window !== "undefined" && this.map) {
      const currentContainer = document.getElementById("map")
      const existingContainer = this.map.getContainer()
      const containerDetached = !existingContainer.isConnected
      const containerReplaced =
        currentContainer !== null && existingContainer !== currentContainer

      if (containerDetached || containerReplaced) {
        if (this.resizeObserver) {
          this.resizeObserver.disconnect()
          this.resizeObserver = null
        }
        if (this.userLocationMarker) {
          this.userLocationMarker.remove()
          this.userLocationMarker = null
        }
        this.clearReportDraftMarker()
        this.clearBarrierMarkers()
        this.clearSharedBarrierMarker()
        this.clearReportMarkers()
        try {
          this.map.remove()
        } catch {
          // ignore map teardown errors during stale-container recovery
        }
        this.map = null
        this.mapController = null
        this.initPromise = null
      } else {
        return this.map
      }
    }
    if (this.initPromise) return this.initPromise
    this.initPromise = this.initializeInternal().catch((error) => {
      this.initPromise = null
      this.map = null
      this.mapController = null
      throw error
    })
    return this.initPromise
  }

  private async initializeInternal(): Promise<MapLibreMap> {
    if (typeof window === "undefined") {
      throw new Error("MapManager can only initialize in the browser")
    }
    const container = document.getElementById("map")
    if (!container) {
      throw new Error('Map container "#map" was not found')
    }
    if (container.querySelector(".maplibregl-canvas")) {
      container.innerHTML = ""
    }

    const controller = await createMapController(this.activeMapType)
    const map = controller.map
    this.mapController = controller

    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.map) return
        this.map.resize()
      })
      this.resizeObserver.observe(container)
    }

    map.on("load", () => {
      map.resize()
      this.rebuildAllLayers()
      this.bindBarrierEvents()
      this.emitViewChange()
    })

    map.on("style.load", () => {
      this.rebuildAllLayers()
      this.bindBarrierEvents()
    })

    map.on("moveend", () => {
      this.emitViewChange()
    })

    map.on("zoom", () => {
      this.syncBarrierMarkerVisibility()
      this.syncReportMarkerVisibility()
    })

    map.on("error", (event: any) => {
      if (event?.error) {
        console.warn("[map] runtime error", event.error)
      }
    })

    map.on("click", this.handleMapClick)

    this.map = map
    return map
  }

  private updateCursor() {
    if (!this.map) return
    if (this.reportPickActive) {
      this.map.getCanvas().style.cursor = "crosshair"
      return
    }
    this.map.getCanvas().style.cursor = ""
  }

  private ensureGeoJsonSource(sourceId: string, data: FeatureCollection): boolean {
    if (!this.map || !this.map.isStyleLoaded()) return false
    try {
      if (!this.map.getSource(sourceId)) {
        this.map.addSource(sourceId, {
          type: "geojson",
          data,
        })
      } else {
        const source = this.map.getSource(sourceId) as GeoJSONSource
        source.setData(data)
      }
      return Boolean(this.map.getSource(sourceId))
    } catch (error) {
      console.warn(`[map] failed to ensure source ${sourceId}`, error)
      return false
    }
  }

  private ensureLayerWithSource(layer: any, sourceId: string) {
    if (!this.map || !this.map.isStyleLoaded()) return
    if (this.map.getLayer(layer.id)) return

    const sourceData = this.currentSourceData(sourceId)
    if (!sourceData) return

    const sourceReady = this.ensureGeoJsonSource(sourceId, sourceData)
    if (!sourceReady || !this.map.getSource(sourceId)) return

    try {
      this.map.addLayer(layer)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("source") && message.includes("not found")) {
        const readyAfterRetry = this.ensureGeoJsonSource(sourceId, sourceData)
        if (!readyAfterRetry || !this.map.getSource(sourceId) || this.map.getLayer(layer.id)) return
        try {
          this.map.addLayer(layer)
        } catch (retryError) {
          console.warn(`[map] failed to add layer ${layer.id} after retry`, retryError)
        }
        return
      }
      console.warn(`[map] failed to add layer ${layer.id}`, error)
    }
  }

  private ensureAnalysisLayers() {
    if (!this.map || !this.map.isStyleLoaded()) return
    this.ensureGeoJsonSource(SOURCE_STREAMS, this.analysisData.streams_geojson)
    this.ensureGeoJsonSource(SOURCE_ACCESSIBLE, this.analysisData.accessible_streams_geojson)
    this.ensureGeoJsonSource(SOURCE_BARRIERS, this.analysisData.barriers_geojson)

    this.ensureLayerWithSource(
      {
        id: LAYER_STREAMS,
        type: "line",
        source: SOURCE_STREAMS,
        paint: {
          "line-color": "#1D7FE8",
          "line-width": 1.5,
          "line-opacity": 0.8,
        },
      },
      SOURCE_STREAMS
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_STREAM_DIRECTION,
        type: "symbol",
        source: SOURCE_STREAMS,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 140,
          "text-field": "▶",
          "text-size": 11,
          "text-keep-upright": false,
          "text-font": ["Open Sans Regular"],
        },
        paint: {
          "text-color": "#0B4A99",
          "text-opacity": 0.75,
          "text-halo-color": "rgba(255,255,255,0.65)",
          "text-halo-width": 0.8,
        },
      },
      SOURCE_STREAMS
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_ACCESSIBLE,
        type: "line",
        source: SOURCE_ACCESSIBLE,
        paint: {
          "line-color": "#34C759",
          "line-width": 3,
          "line-opacity": 0.85,
        },
      },
      SOURCE_ACCESSIBLE
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_BARRIERS_GLOW,
        type: "circle",
        source: SOURCE_BARRIERS,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["coalesce", ["to-number", ["get", "gain_km"]], 0],
            0,
            10,
            1,
            14,
            5,
            18,
            20,
            24,
          ],
          "circle-color": "#007AFF",
          "circle-opacity": 0.3,
          "circle-blur": 2,
        },
      },
      SOURCE_BARRIERS
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_BARRIERS,
        type: "circle",
        source: SOURCE_BARRIERS,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["coalesce", ["to-number", ["get", "gain_km"]], 0],
            0,
            6,
            1,
            8,
            5,
            11,
            20,
            15,
          ],
          "circle-color": [
            "match",
            ["get", "type"],
            "dam",
            "#FF6B35",
            "weir",
            "#007AFF",
            "waterfall",
            "#AF52DE",
            "#FF6B35",
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#FFFFFF",
        },
      },
      SOURCE_BARRIERS
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_BARRIERS_ICON,
        type: "symbol",
        source: SOURCE_BARRIERS,
        layout: {
          "text-field": [
            "match",
            ["get", "type"],
            "dam",
            "◆",
            "weir",
            "△",
            "waterfall",
            "✦",
            "●",
          ],
          "text-size": 10,
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#FFFFFF",
          "text-opacity": 0.95,
        },
      },
      SOURCE_BARRIERS
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_BARRIERS_SELECTED,
        type: "circle",
        source: SOURCE_BARRIERS,
        paint: {
          "circle-radius": 9,
          "circle-color": "#007AFF",
          "circle-opacity": 0.25,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#007AFF",
        },
        filter: ["==", ["get", "barrier_id"], "__none__"],
      },
      SOURCE_BARRIERS
    )

  }

  private bboxPolygonFeature(bbox: BBox): FeatureCollection {
    const [minLon, minLat, maxLon, maxLat] = bbox
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [minLon, minLat],
                [maxLon, minLat],
                [maxLon, maxLat],
                [minLon, maxLat],
                [minLon, minLat],
              ],
            ],
          },
          properties: {},
        },
      ],
    }
  }

  private ensureSelectionLayers() {
    if (!this.map || !this.map.isStyleLoaded()) return
    this.ensureGeoJsonSource(
      SOURCE_BBOX,
      this.bbox ? this.bboxPolygonFeature(this.bbox) : { type: "FeatureCollection", features: [] }
    )
    this.ensureLayerWithSource(
      {
        id: LAYER_BBOX_FILL,
        type: "fill",
        source: SOURCE_BBOX,
        paint: {
          "fill-color": "#007AFF",
          "fill-opacity": this.bboxDisplayMode === "fill" ? 0.18 : 0.03,
        },
      },
      SOURCE_BBOX
    )
    this.ensureLayerWithSource(
      {
        id: LAYER_BBOX_LINE,
        type: "line",
        source: SOURCE_BBOX,
        paint: {
          "line-color": "#007AFF",
          "line-width": 3,
          "line-dasharray": this.bboxDisplayMode === "fill" ? [2, 2] : [1, 0],
          "line-opacity": 0.95,
        },
      },
      SOURCE_BBOX
    )
    // Keep selection box visible above other overlays.
    if (this.map.getLayer(LAYER_BBOX_FILL)) {
      try {
        this.map.moveLayer(LAYER_BBOX_FILL)
      } catch {
        // ignore layer ordering failures
      }
    }
    if (this.map.getLayer(LAYER_BBOX_LINE)) {
      try {
        this.map.moveLayer(LAYER_BBOX_LINE)
      } catch {
        // ignore layer ordering failures
      }
    }
    if (this.map.getLayer(LAYER_BBOX_FILL)) {
      this.map.setLayoutProperty(LAYER_BBOX_FILL, "visibility", "visible")
    }
    if (this.map.getLayer(LAYER_BBOX_LINE)) {
      this.map.setLayoutProperty(LAYER_BBOX_LINE, "visibility", "visible")
    }
  }

  private ensureReportsLayer() {
    if (!this.map || !this.map.isStyleLoaded()) return
    const reportsGeoJson = this.currentSourceData(SOURCE_REPORTS)
    if (!reportsGeoJson) return

    this.ensureGeoJsonSource(SOURCE_REPORTS, reportsGeoJson)
    this.ensureLayerWithSource(
      {
        id: LAYER_REPORTS,
        type: "circle",
        source: SOURCE_REPORTS,
        paint: {
          "circle-radius": 5.5,
          "circle-color": "#FF3B30",
          "circle-stroke-width": 1.6,
          "circle-stroke-color": "#FFFFFF",
          "circle-opacity": 0.9,
        },
      },
      SOURCE_REPORTS
    )
  }

  private ensureUserLocationLayer() {
    if (!this.map || !this.map.isStyleLoaded()) return
    this.ensureGeoJsonSource(
      SOURCE_USER_LOCATION,
      this.userLocation
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: this.userLocation },
                properties: {},
              },
            ],
          }
        : { type: "FeatureCollection", features: [] }
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_USER_LOCATION_HALO,
        type: "circle",
        source: SOURCE_USER_LOCATION,
        paint: {
          "circle-radius": 14,
          "circle-color": "#007AFF",
          "circle-opacity": 0.2,
        },
      },
      SOURCE_USER_LOCATION
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_USER_LOCATION,
        type: "circle",
        source: SOURCE_USER_LOCATION,
        paint: {
          "circle-radius": 6,
          "circle-color": "#007AFF",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#FFFFFF",
        },
      },
      SOURCE_USER_LOCATION
    )
  }

  private ensureUserAccuracyLayer() {
    if (!this.map || !this.map.isStyleLoaded()) return
    this.ensureGeoJsonSource(
      SOURCE_USER_ACCURACY,
      !this.userLocation || !this.userAccuracyMeters || this.userAccuracyMeters <= 0
        ? { type: "FeatureCollection", features: [] }
        : this.buildAccuracyPolygon(this.userLocation, this.userAccuracyMeters)
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_USER_ACCURACY_BASE,
        type: "fill",
        source: SOURCE_USER_ACCURACY,
        paint: {
          "fill-color": "#FFFFFF",
          "fill-opacity": 0.34,
        },
      },
      SOURCE_USER_ACCURACY
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_USER_ACCURACY,
        type: "fill",
        source: SOURCE_USER_ACCURACY,
        paint: {
          "fill-color": "#0A84FF",
          "fill-opacity": 0.14,
        },
      },
      SOURCE_USER_ACCURACY
    )

    this.ensureLayerWithSource(
      {
        id: LAYER_USER_ACCURACY_STROKE,
        type: "line",
        source: SOURCE_USER_ACCURACY,
        paint: {
          "line-color": "rgba(10,132,255,0.4)",
          "line-width": 1.25,
          "line-opacity": 0.7,
        },
      },
      SOURCE_USER_ACCURACY
    )
  }

  private async ensureUserLocationMarker() {
    if (typeof window === "undefined") return
    if (!this.map || !this.userLocation) return

    if (!this.userLocationMarker) {
      const moduleValue = await import("maplibre-gl")
      const maplibregl = (moduleValue.default ?? moduleValue) as typeof import("maplibre-gl")
      const element = document.createElement("div")
      element.className = "user-location-ping"
      this.userLocationMarker = new maplibregl.Marker({
        element,
        anchor: "center",
        subpixelPositioning: true,
      })
    }

    this.userLocationMarker.setLngLat(this.userLocation).addTo(this.map)
  }

  private clearBarrierMarkers() {
    for (const marker of this.barrierMarkers.values()) {
      marker.remove()
    }
    this.barrierMarkers.clear()
    this.barrierMarkerElements.clear()
  }

  private clearSharedBarrierMarker() {
    if (this.sharedBarrierMarker) {
      this.sharedBarrierMarker.remove()
      this.sharedBarrierMarker = null
    }
    this.sharedBarrierMarkerElement = null
  }

  private clearReportMarkers() {
    for (const marker of this.reportMarkers.values()) {
      marker.remove()
    }
    this.reportMarkers.clear()
    this.reportMarkerElements.clear()
  }

  private clearReportDraftMarker() {
    if (this.reportDraftMarker) {
      this.reportDraftMarker.remove()
      this.reportDraftMarker = null
    }
    this.reportDraftMarkerElement = null
    if (this.map) {
      const container = this.map.getContainer()
      const draftNodes = container.querySelectorAll(".report-draft-pin")
      for (const node of draftNodes) {
        const markerNode = node.closest(".maplibregl-marker")
        if (markerNode instanceof HTMLElement) {
          markerNode.remove()
          continue
        }
        if (node instanceof HTMLElement) {
          node.remove()
        }
      }
    }
  }

  private normalizeBarrierType(type: string) {
    if (type === "weir" || type === "waterfall" || type === "dam") {
      return type
    }
    return "dam"
  }

  private playBarrierSelectionAnimation(barrierId: string) {
    if (typeof window === "undefined") return
    if (this.map?.isMoving()) {
      this.map.once("moveend", () => {
        if (this.selectedBarrierId === barrierId) {
          this.playBarrierSelectionAnimation(barrierId)
        }
      })
      return
    }
    const element =
      this.barrierMarkerElements.get(barrierId) ??
      (this.sharedBarrierPreview?.id === barrierId ? this.sharedBarrierMarkerElement : null)
    if (!element) return
    element.classList.remove("is-animating")
    // Force reflow so repeated selection can replay animation.
    void element.offsetWidth
    element.classList.add("is-animating")
    window.setTimeout(() => {
      element.classList.remove("is-animating")
    }, 620)
  }

  private playReportSelectionAnimation(reportId: string) {
    if (typeof window === "undefined") return
    if (this.map?.isMoving()) {
      this.map.once("moveend", () => {
        if (this.selectedReportId === reportId) {
          this.playReportSelectionAnimation(reportId)
        }
      })
      return
    }
    const element = this.reportMarkerElements.get(reportId)
    if (!element) return
    element.classList.remove("is-animating")
    void element.offsetWidth
    element.classList.add("is-animating")
    window.setTimeout(() => {
      element.classList.remove("is-animating")
    }, 620)
  }

  private playReportDraftSelectionAnimation() {
    if (typeof window === "undefined") return
    if (this.map?.isMoving()) {
      this.map.once("moveend", () => {
        this.playReportDraftSelectionAnimation()
      })
      return
    }
    const element = this.reportDraftMarkerElement
    if (!element) return
    element.classList.remove("is-animating")
    void element.offsetWidth
    element.classList.add("is-animating")
    window.setTimeout(() => {
      element.classList.remove("is-animating")
    }, 620)
  }

  private markerOpacityForZoom() {
    if (!this.map) return 1
    const zoom = this.map.getZoom()
    if (zoom <= 6.5) return 0
    if (zoom >= 9) return 1
    return (zoom - 6.5) / (9 - 6.5)
  }

  private createBarrierPinElement(barrierId: string, barrierType: string, label: string) {
    const button = document.createElement("button")
    button.type = "button"
    const safeType = this.normalizeBarrierType(barrierType)
    button.className = `barrier-pin barrier-pin--${safeType}`
    button.setAttribute("aria-label", label)
    button.setAttribute("title", label)

    const inner = document.createElement("span")
    inner.className = "barrier-pin__inner"
    inner.setAttribute("aria-hidden", "true")
    button.appendChild(inner)

    button.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.setSelectedBarrier(barrierId)
      this.barrierClickHandler?.(barrierId)
    })

    return button
  }

  private createReportPinElement(reportId: string, label: string) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "barrier-pin barrier-pin--report"
    button.setAttribute("aria-label", label)
    button.setAttribute("title", label)

    const inner = document.createElement("span")
    inner.className = "barrier-pin__inner"
    inner.setAttribute("aria-hidden", "true")
    button.appendChild(inner)

    button.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.setSelectedReport(reportId)
      this.reportClickHandler?.(reportId)
    })

    return button
  }

  private createDraftReportPinElement() {
    const element = document.createElement("div")
    element.className = "barrier-pin barrier-pin--report report-draft-pin"
    element.setAttribute("aria-hidden", "true")
    element.style.pointerEvents = "none"

    const inner = document.createElement("span")
    inner.className = "barrier-pin__inner"
    inner.setAttribute("aria-hidden", "true")
    element.appendChild(inner)

    return element
  }

  private async ensureDraftReportMarker(animate = false) {
    if (typeof window === "undefined") return
    if (!this.map || !this.reportMarker) return

    if (!this.reportDraftMarker) {
      const moduleValue = await import("maplibre-gl")
      const maplibregl = (moduleValue.default ?? moduleValue) as typeof import("maplibre-gl")
      const element = this.createDraftReportPinElement()
      this.reportDraftMarkerElement = element
      this.reportDraftMarker = new maplibregl.Marker({
        element,
        anchor: "center",
        subpixelPositioning: true,
      })
    }

    this.reportDraftMarker.setLngLat(this.reportMarker).addTo(this.map)
    if (animate) {
      this.playReportDraftSelectionAnimation()
    }
  }

  private async renderBarrierMarkers() {
    if (typeof window === "undefined") return
    if (!this.map) return

    this.clearBarrierMarkers()

    const moduleValue = await import("maplibre-gl")
    const maplibregl = (moduleValue.default ?? moduleValue) as typeof import("maplibre-gl")
    const features = this.analysisData.barriers_geojson.features
      .filter((feature): feature is typeof feature & { geometry: { type: "Point"; coordinates: [number, number] } } =>
        feature.geometry?.type === "Point" && Array.isArray(feature.geometry.coordinates)
      )
      .slice(0, 1200)

    for (const feature of features) {
      const props = (feature.properties ?? {}) as Record<string, unknown>
      const barrierIdRaw = props.barrier_id
      if (typeof barrierIdRaw !== "string" || barrierIdRaw.trim().length === 0) continue
      const barrierId = barrierIdRaw.trim()
      const barrierType = typeof props.type === "string" ? this.normalizeBarrierType(props.type) : "dam"
      const name = typeof props.name === "string" && props.name.trim().length > 0 ? props.name : barrierId
      const element = this.createBarrierPinElement(barrierId, barrierType, name)

      const marker = new maplibregl.Marker({
        element,
        anchor: "center",
        subpixelPositioning: true,
      })
        .setLngLat(feature.geometry.coordinates)
        .addTo(this.map)

      this.barrierMarkers.set(barrierId, marker)
      this.barrierMarkerElements.set(barrierId, element)
    }

    await this.ensureSharedBarrierMarker()
    this.applyLayerVisibility()
    this.syncBarrierMarkerSelection()
    this.syncBarrierMarkerVisibility()
  }

  private async ensureSharedBarrierMarker() {
    if (typeof window === "undefined") return
    if (!this.map) return
    if (!this.sharedBarrierPreview) {
      this.clearSharedBarrierMarker()
      return
    }
    if (this.barrierMarkers.has(this.sharedBarrierPreview.id)) {
      this.clearSharedBarrierMarker()
      return
    }

    if (!this.sharedBarrierMarker) {
      const moduleValue = await import("maplibre-gl")
      const maplibregl = (moduleValue.default ?? moduleValue) as typeof import("maplibre-gl")
      const element = this.createBarrierPinElement(
        this.sharedBarrierPreview.id,
        this.sharedBarrierPreview.type,
        this.sharedBarrierPreview.name
      )
      element.classList.add("shared-link-pin")
      this.sharedBarrierMarkerElement = element
      this.sharedBarrierMarker = new maplibregl.Marker({
        element,
        anchor: "center",
        subpixelPositioning: true,
      })
    }

    this.sharedBarrierMarker
      .setLngLat(this.sharedBarrierPreview.coordinates)
      .addTo(this.map)
  }

  private async renderReportMarkers() {
    if (typeof window === "undefined") return
    if (!this.map) return

    this.clearReportMarkers()

    const moduleValue = await import("maplibre-gl")
    const maplibregl = (moduleValue.default ?? moduleValue) as typeof import("maplibre-gl")

    const reports = this.reportsData
      .filter(
        (report): report is ReportRecord & { coordinates: [number, number] } =>
          !report.barrier_id &&
          Array.isArray(report.coordinates) &&
          report.coordinates.length === 2
      )
      .slice(0, 1200)

    for (const report of reports) {
      const reportId = report.report_id
      const label = report.category || "Report"
      const element = this.createReportPinElement(reportId, label)
      const marker = new maplibregl.Marker({
        element,
        anchor: "center",
        subpixelPositioning: true,
      })
        .setLngLat(report.coordinates)
        .addTo(this.map)

      this.reportMarkers.set(reportId, marker)
      this.reportMarkerElements.set(reportId, element)
    }

    this.syncReportMarkerSelection()
    this.syncReportMarkerVisibility()
  }

  private syncBarrierMarkerSelection() {
    for (const [barrierId, element] of this.barrierMarkerElements.entries()) {
      element.classList.toggle("is-selected", barrierId === this.selectedBarrierId)
    }
    if (this.sharedBarrierMarkerElement) {
      this.sharedBarrierMarkerElement.classList.toggle(
        "is-selected",
        this.sharedBarrierPreview?.id === this.selectedBarrierId
      )
    }
  }

  private syncBarrierMarkerVisibility() {
    const visible = this.layerVisibility.barriers
    const opacity = visible ? this.markerOpacityForZoom() : 0
    const pointerEvents = visible && opacity > 0.04 ? "auto" : "none"
    for (const element of this.barrierMarkerElements.values()) {
      element.style.opacity = opacity.toFixed(3)
      element.style.pointerEvents = pointerEvents
    }
    if (this.sharedBarrierMarkerElement) {
      this.sharedBarrierMarkerElement.style.opacity = opacity.toFixed(3)
      this.sharedBarrierMarkerElement.style.pointerEvents = pointerEvents
    }
  }

  private syncReportMarkerVisibility() {
    const visible = this.layerVisibility.reports
    const opacity = visible ? this.markerOpacityForZoom() : 0
    const pointerEvents = visible && opacity > 0.04 ? "auto" : "none"
    for (const element of this.reportMarkerElements.values()) {
      element.style.opacity = opacity.toFixed(3)
      element.style.pointerEvents = pointerEvents
    }
  }

  private syncReportMarkerSelection() {
    for (const [reportId, element] of this.reportMarkerElements.entries()) {
      element.classList.toggle("is-selected", reportId === this.selectedReportId)
    }
  }

  private applyLayerVisibility() {
    if (!this.map || !this.map.isStyleLoaded()) return
    const useNativeBarrierLayers = false
    const useNativeReportLayers = false
    const setVisibility = (layerId: string, visible: boolean) => {
      if (!this.map?.getLayer(layerId)) return
      this.map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none")
    }

    setVisibility(LAYER_STREAMS, this.layerVisibility.streams)
    setVisibility(LAYER_STREAM_DIRECTION, this.layerVisibility.streams)
    setVisibility(LAYER_ACCESSIBLE, this.layerVisibility.accessible)
    setVisibility(LAYER_BARRIERS, this.layerVisibility.barriers && useNativeBarrierLayers)
    setVisibility(LAYER_BARRIERS_ICON, this.layerVisibility.barriers && useNativeBarrierLayers)
    setVisibility(LAYER_BARRIERS_GLOW, this.layerVisibility.barriers && useNativeBarrierLayers)
    setVisibility(LAYER_BARRIERS_SELECTED, this.layerVisibility.barriers && useNativeBarrierLayers)
    setVisibility(LAYER_REPORTS, this.layerVisibility.reports && useNativeReportLayers)
    this.syncBarrierMarkerVisibility()
    this.syncReportMarkerVisibility()
  }

  private applySelectedBarrierFilter() {
    if (!this.map || !this.map.isStyleLoaded() || !this.map.getLayer(LAYER_BARRIERS_SELECTED)) return
    this.map.setFilter(
      LAYER_BARRIERS_SELECTED,
      this.selectedBarrierId
        ? ["==", ["get", "barrier_id"], this.selectedBarrierId]
        : ["==", ["get", "barrier_id"], "__none__"]
    )
  }

  private rebuildAllLayers() {
    if (!this.map || !this.map.isStyleLoaded()) return
    this.ensureAnalysisLayers()
    this.ensureSelectionLayers()
    this.ensureReportsLayer()
    this.ensureUserAccuracyLayer()
    this.ensureUserLocationLayer()
    if (this.userLocation) {
      void this.ensureUserLocationMarker()
    }
    
    // Move barrier layers to top for better visibility
    if (this.map.getLayer(LAYER_BARRIERS)) {
      try {
        this.map.moveLayer(LAYER_BARRIERS)
      } catch {
        // Layer already on top or error
      }
    }
    if (this.map.getLayer(LAYER_BARRIERS_SELECTED)) {
      try {
        this.map.moveLayer(LAYER_BARRIERS_SELECTED)
      } catch {
        // Layer already on top or error
      }
    }
    
    this.applyLayerVisibility()
    this.applySelectedBarrierFilter()
    void this.renderBarrierMarkers()
    void this.renderReportMarkers()
    if (this.reportMarker) {
      void this.ensureDraftReportMarker()
    } else {
      this.clearReportDraftMarker()
    }
  }

  private emitViewChange() {
    const bbox = this.getCurrentViewBBox()
    if (!bbox) return
    for (const listener of this.viewListeners) {
      listener(bbox)
    }
  }

  private handleMapClick = (event: any) => {
    if (!this.reportPickActive) return
    const point: [number, number] = [event.lngLat.lng, event.lngLat.lat]
    void this.setReportMarker(point)
    this.reportPickActive = false
    this.updateCursor()
    const handler = this.reportPickHandler
    this.reportPickHandler = null
    handler?.(point)
  }

  private handleBarrierClick = (event: any) => {
    if (this.reportPickActive) return
    const feature = event.features?.[0]
    const barrierId = feature?.properties?.barrier_id
    if (typeof barrierId !== "string") return
    void this.setSelectedBarrier(barrierId)
    this.barrierClickHandler?.(barrierId)
  }

  private handleBarrierMouseEnter = () => {
    if (!this.map) return
    if (this.reportPickActive) return
    this.map.getCanvas().style.cursor = "pointer"
  }

  private handleBarrierMouseLeave = () => {
    this.updateCursor()
  }

  private bindBarrierEvents() {
    if (!this.map || !this.map.isStyleLoaded()) return
    if (!this.map.getLayer(LAYER_BARRIERS)) return

    this.map.off("click", LAYER_BARRIERS, this.handleBarrierClick)
    this.map.off("mouseenter", LAYER_BARRIERS, this.handleBarrierMouseEnter)
    this.map.off("mouseleave", LAYER_BARRIERS, this.handleBarrierMouseLeave)

    this.map.on("click", LAYER_BARRIERS, this.handleBarrierClick)
    this.map.on("mouseenter", LAYER_BARRIERS, this.handleBarrierMouseEnter)
    this.map.on("mouseleave", LAYER_BARRIERS, this.handleBarrierMouseLeave)
  }

  async setStyle(type: MapType): Promise<boolean> {
    await this.initialize()
    if (!this.mapController) return false
    const ok = this.mapController.setMapMode(type)
    if (!ok) return false
    this.activeMapType = type
    return true
  }

  async flyTo(options: { center?: [number, number]; zoom?: number; bbox?: BBox; padding?: number }) {
    const map = await this.initialize()
    if (options.bbox) {
      const [minLon, minLat, maxLon, maxLat] = options.bbox
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat],
        ],
        {
          padding: options.padding ?? 60,
          duration: 650,
        }
      )
      return
    }
    if (!options.center) return
    map.flyTo({
      center: options.center,
      zoom: options.zoom ?? Math.max(12, map.getZoom()),
      duration: 650,
    })
  }

  async zoomIn() {
    const map = await this.initialize()
    map.zoomIn({ duration: 200 })
  }

  async zoomOut() {
    const map = await this.initialize()
    map.zoomOut({ duration: 200 })
  }

  async setSelectedBarrier(barrierId: string | null) {
    this.selectedBarrierId = barrierId
    await this.initialize()
    this.applySelectedBarrierFilter()
    this.syncBarrierMarkerSelection()
    if (barrierId) {
      this.playBarrierSelectionAnimation(barrierId)
    }
  }

  getSelectedBarrierId() {
    return this.selectedBarrierId
  }

  async focusBarrier(barrierId: string, center: [number, number], zoom = 13.5) {
    await this.initialize()
    this.selectedBarrierId = barrierId
    this.applySelectedBarrierFilter()
    this.syncBarrierMarkerSelection()
    await this.flyTo({ center, zoom })
    this.playBarrierSelectionAnimation(barrierId)
  }

  async setSharedBarrierPreview(
    preview: {
      id: string
      coordinates: [number, number]
      type?: string
      name?: string
    } | null
  ) {
    this.sharedBarrierPreview = preview
      ? {
          id: preview.id,
          coordinates: preview.coordinates,
          type:
            typeof preview.type === "string"
              ? this.normalizeBarrierType(preview.type)
              : "dam",
          name:
            typeof preview.name === "string" && preview.name.trim().length > 0
              ? preview.name.trim()
              : preview.id,
        }
      : null

    await this.initialize()
    this.clearSharedBarrierMarker()
    await this.ensureSharedBarrierMarker()
    this.syncBarrierMarkerSelection()
    this.syncBarrierMarkerVisibility()
  }

  async setSelectedReport(reportId: string | null) {
    this.selectedReportId = reportId
    await this.initialize()
    this.syncReportMarkerSelection()
    if (reportId) {
      this.playReportSelectionAnimation(reportId)
    }
  }

  getSelectedReportId() {
    return this.selectedReportId
  }

  async focusReport(reportId: string, center: [number, number], zoom = 13.5) {
    await this.initialize()
    this.selectedReportId = reportId
    this.syncReportMarkerSelection()
    await this.flyTo({ center, zoom })
    this.playReportSelectionAnimation(reportId)
  }

  getReportById(reportId: string): ReportRecord | null {
    return this.reportsData.find((report) => report.report_id === reportId) ?? null
  }

  async setBBox(bbox: BBox) {
    this.bbox = bbox
    await this.initialize()
    this.ensureSelectionLayers()
  }

  async setBBoxDisplayMode(mode: "fill" | "outline") {
    this.bboxDisplayMode = mode
    await this.initialize()
    this.ensureSelectionLayers()
  }

  async clearBBox() {
    this.bbox = null
    this.bboxDisplayMode = "fill"
    await this.initialize()
    this.ensureSelectionLayers()
  }

  async setReportMarker(coords: [number, number]) {
    this.reportMarker = coords
    await this.initialize()
    await this.ensureDraftReportMarker(true)
  }

  async clearReportMarker() {
    this.reportMarker = null
    this.reportPickActive = false
    this.reportPickHandler = null
    this.clearReportDraftMarker()
    await this.initialize()
    this.updateCursor()
  }

  async setUserLocation(coords: [number, number], accuracyMeters?: number | null) {
    this.userLocation = coords
    this.userAccuracyMeters =
      typeof accuracyMeters === "number" && Number.isFinite(accuracyMeters) && accuracyMeters > 0
        ? Math.min(Math.max(accuracyMeters, 22), 600)
        : null
    await this.initialize()
    this.ensureUserAccuracyLayer()
    this.ensureUserLocationLayer()
    await this.ensureUserLocationMarker()
  }

  getCurrentViewBBox(): BBox | null {
    if (!this.map) return null
    const bounds = this.map.getBounds()
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
  }

  async setAnalysisData(payload: AnalyzeResultPayload) {
    this.analysisData = {
      ...this.analysisData,
      streams_geojson: payload.streams_geojson,
      accessible_streams_geojson: payload.accessible_streams_geojson,
      barriers_geojson: payload.barriers_geojson,
    }
    await this.initialize()
    this.ensureAnalysisLayers()
    this.applyLayerVisibility()
    this.bindBarrierEvents()
    await this.renderBarrierMarkers()
  }

  async setReportsData(reports: ReportRecord[]) {
    this.reportsData = reports.filter((report) => !report.barrier_id)
    if (
      this.selectedReportId &&
      !this.reportsData.some((report) => report.report_id === this.selectedReportId)
    ) {
      this.selectedReportId = null
    }
    await this.initialize()
    this.ensureReportsLayer()
    this.applyLayerVisibility()
    await this.renderReportMarkers()
  }

  setBarrierClickHandler(handler: ((barrierId: string) => void) | null) {
    this.barrierClickHandler = handler
  }

  setReportClickHandler(handler: ((reportId: string) => void) | null) {
    this.reportClickHandler = handler
  }

  subscribeViewChange(listener: (bbox: BBox) => void): () => void {
    this.viewListeners.add(listener)
    const bbox = this.getCurrentViewBBox()
    if (bbox) {
      listener(bbox)
    } else {
      void this.initialize().then(() => {
        const initializedBbox = this.getCurrentViewBBox()
        if (initializedBbox && this.viewListeners.has(listener)) {
          listener(initializedBbox)
        }
      })
    }
    return () => {
      this.viewListeners.delete(listener)
    }
  }

  async setReportPickMode(enabled: boolean, handler?: (coords: [number, number]) => void) {
    await this.initialize()
    this.reportPickActive = enabled
    this.reportPickHandler = enabled ? handler ?? null : null
    this.updateCursor()
  }
}

export const mapManager = new MapManager()

export type { MapType }

