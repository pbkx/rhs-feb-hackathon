"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { useAppState, type MockBarrier } from "@/lib/app-context"
import { candidatesFromAnalyzeResult } from "@/lib/barrier-candidate"
import { mapManager, type MapType } from "@/lib/map/manager"
import { getReports, type ReportRecord } from "@/lib/api/client"

function parseSharedBarrierPayload(raw: string): MockBarrier | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const parsedObject = parsed as { barrier?: Record<string, unknown> } & Record<string, unknown>
    const source = ("barrier" in parsedObject ? parsedObject.barrier : parsedObject) as
      | Record<string, unknown>
      | undefined
    if (!source) return null

    const id = typeof source.id === "string" ? source.id.trim() : ""
    if (!id) return null

    const lat = Number(source.lat)
    const lng = Number(source.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

    const type = source.type === "weir" || source.type === "waterfall" ? source.type : "dam"
    const confidence =
      source.confidence === "high" || source.confidence === "medium" || source.confidence === "low"
        ? source.confidence
        : "medium"

    const tags = Object.fromEntries(
      Object.entries((source.tags as Record<string, unknown>) ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    )

    const inferredSignals = Array.isArray(source.inferredSignals)
      ? source.inferredSignals.filter((value): value is string => typeof value === "string")
      : ["Explicitly tagged in OpenStreetMap."]

    return {
      id,
      name: typeof source.name === "string" && source.name.trim().length > 0 ? source.name : "Shared barrier",
      type,
      gain: Number.isFinite(Number(source.gain)) ? Number(source.gain) : 0,
      upstreamBlocked: Number.isFinite(Number(source.upstreamBlocked)) ? Number(source.upstreamBlocked) : 0,
      confidence,
      distance: Number.isFinite(Number(source.distance)) ? Number(source.distance) : 0,
      osmId: typeof source.osmId === "string" && source.osmId.trim().length > 0 ? source.osmId : id,
      tags,
      inferredSignals,
      calculationMethod:
        typeof source.calculationMethod === "string" && source.calculationMethod.trim().length > 0
          ? source.calculationMethod
          : undefined,
      lat,
      lng,
    }
  } catch {
    return null
  }
}

export function MapContainer() {
  const {
    activeMode,
    panelOpen,
    currentView,
    bboxSelected,
    candidates,
    selectedBarrier,
    selectedReport,
    reportDraft,
    reportLocationMode,
    analysisPayload,
    nearbyReports,
    updateReportDraft,
    setSelectedBarrier,
    setSelectedReport,
    setNearbyReports,
    setActiveMode,
    setUserLocation,
    resetNav,
    pushView,
    setReportLocationMode,
  } = useAppState()

  const [mapType, setMapType] = useState<MapType>("standard")
  const [showMapTypes, setShowMapTypes] = useState(false)
  const [locating, setLocating] = useState(false)
  const [sharedBarrier, setSharedBarrier] = useState<MockBarrier | null>(null)
  const [sharedReport, setSharedReport] = useState<ReportRecord | null>(null)

  const candidateIndex = useMemo(() => {
    const index = new Map<string, MockBarrier>()
    for (const candidate of candidates) {
      index.set(candidate.id, candidate)
    }
    if (analysisPayload) {
      for (const candidate of candidatesFromAnalyzeResult(analysisPayload)) {
        if (!index.has(candidate.id)) {
          index.set(candidate.id, candidate)
        }
      }
    }
    return index
  }, [analysisPayload, candidates])

  useEffect(() => {
    void mapManager.initialize().catch((error) => {
      console.error("[map] initialize failed", error)
      toast.error("Map failed to initialize")
    })
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    const barrierPayloadRaw = url.searchParams.get("barrier_payload")
    const barrierFromPayload = barrierPayloadRaw ? parseSharedBarrierPayload(barrierPayloadRaw) : null
    if (barrierFromPayload) {
      void mapManager.setSharedBarrierPreview({
        id: barrierFromPayload.id,
        coordinates: [barrierFromPayload.lng, barrierFromPayload.lat],
        type: barrierFromPayload.type,
        name: barrierFromPayload.name,
      })
      void mapManager.flyTo({ center: [barrierFromPayload.lng, barrierFromPayload.lat], zoom: 13.5 })
      setSharedBarrier(barrierFromPayload)
    } else {
      void mapManager.setSharedBarrierPreview(null)
      const reportId = url.searchParams.get("report")
      if (reportId) {
        const reportLatRaw = url.searchParams.get("r_lat")
        const reportLngRaw = url.searchParams.get("r_lng")
        const reportLat = Number(reportLatRaw)
        const reportLng = Number(reportLngRaw)
        const hasCoords = Number.isFinite(reportLat) && Number.isFinite(reportLng)
        const reportsCount = Number(url.searchParams.get("reports") ?? "1") || 1
        const renouncements = Number(url.searchParams.get("renouncements") ?? "0") || 0
        const linkedReport: ReportRecord = {
          report_id: reportId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_confirmed_at: url.searchParams.get("last_confirmed_at"),
          category: url.searchParams.get("category") ?? "Report",
          description: url.searchParams.get("description") ?? "Shared report",
          include_coordinates: hasCoords,
          coordinates: hasCoords ? [reportLng, reportLat] : null,
          reports_count: reportsCount,
          confirmations: 0,
          renouncements,
          effective_reports: reportsCount - renouncements,
          confidence:
            url.searchParams.get("confidence") === "high"
              ? "high"
              : url.searchParams.get("confidence") === "medium"
              ? "medium"
              : "low",
        }
        if (hasCoords) {
          void mapManager.flyTo({ center: [reportLng, reportLat], zoom: 13.5 })
        }
        setSharedReport(linkedReport)
      }
    }

    const paramsToClear = [
      "barrier_payload",
      "report",
      "category",
      "description",
      "reports",
      "renouncements",
      "last_confirmed_at",
      "r_lat",
      "r_lng",
    ]
    let changed = false
    for (const key of paramsToClear) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key)
        changed = true
      }
    }
    if (changed) {
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`)
    }
  }, [])

  useEffect(() => {
    if (!sharedBarrier) return
    const match = candidateIndex.get(sharedBarrier.id)
    const resolvedBarrier = match ?? sharedBarrier
    setSelectedBarrier(resolvedBarrier)
    setActiveMode("analyze")
    window.setTimeout(() => {
      resetNav("AnalyzeResults")
      pushView("BarrierDetails")
    }, 0)
    setSharedBarrier(null)
  }, [candidateIndex, pushView, resetNav, setActiveMode, setSelectedBarrier, sharedBarrier])

  useEffect(() => {
    if (!sharedReport) return
    const match = nearbyReports.find((report) => report.report_id === sharedReport.report_id)
    const resolvedReport = match ?? sharedReport
    setSelectedReport(resolvedReport)
    if (resolvedReport.coordinates) {
      void mapManager.focusReport(resolvedReport.report_id, resolvedReport.coordinates, 13.5)
    }
    setActiveMode("search")
    window.setTimeout(() => {
      resetNav("SearchResults")
      pushView("ReportDetails")
    }, 0)
    setSharedReport(null)
  }, [nearbyReports, pushView, resetNav, setActiveMode, setSelectedReport, sharedReport])

  useEffect(() => {
    if (!analysisPayload) return
    void mapManager.setAnalysisData(analysisPayload)
  }, [analysisPayload])

  useEffect(() => {
    if (!analysisPayload) {
      void mapManager.setReportsData([])
      setNearbyReports([])
      return
    }
  }, [analysisPayload])

  useEffect(() => {
    if (!analysisPayload) return

    const fetchReports = async () => {
      try {
        const response = await getReports(analysisPayload.meta.bbox)
        const locationReports = response.reports.filter((report) => !report.barrier_id)
        setNearbyReports(locationReports)
        await mapManager.setReportsData(locationReports)
      } catch (error) {
        console.error("[map] failed to fetch reports", error)
      }
    }

    void fetchReports()
  }, [analysisPayload])

  useEffect(() => {
    let timeout: number | null = null
    return mapManager.subscribeViewChange((bbox) => {
      if (timeout) window.clearTimeout(timeout)
      timeout = window.setTimeout(async () => {
        try {
          const response = await getReports(bbox)
          const locationReports = response.reports.filter((report) => !report.barrier_id)
          setNearbyReports(locationReports)
          await mapManager.setReportsData(locationReports)
        } catch (error) {
          console.error("[map] failed to refresh nearby reports", error)
        }
      }, 350)
    })
  }, [setNearbyReports])

  useEffect(() => {
    if (!bboxSelected) {
      void mapManager.clearBBox()
      return
    }
    void mapManager.setBBox(bboxSelected)
  }, [bboxSelected])

  useEffect(() => {
    const targetId = selectedBarrier?.id ?? null
    if (mapManager.getSelectedBarrierId() === targetId) return
    void mapManager.setSelectedBarrier(targetId)
  }, [selectedBarrier])

  useEffect(() => {
    const targetId = selectedReport?.report_id ?? null
    if (mapManager.getSelectedReportId() === targetId) return
    void mapManager.setSelectedReport(targetId)
  }, [selectedReport])

  useEffect(() => {
    if (activeMode !== "report" || !panelOpen) {
      void mapManager.clearReportMarker()
      return
    }
    if (reportDraft.coordinates) {
      void mapManager.setReportMarker(reportDraft.coordinates)
      return
    }
    void mapManager.clearReportMarker()
  }, [activeMode, panelOpen, reportDraft.coordinates])

  useEffect(() => {
    if (panelOpen && activeMode === "report") return
    if (reportLocationMode) {
      setReportLocationMode(false)
    }
    if (reportDraft.coordinates) {
      updateReportDraft({ coordinates: null })
    }
    void mapManager.setReportPickMode(false)
    void mapManager.clearReportMarker()
  }, [
    activeMode,
    panelOpen,
    reportDraft.coordinates,
    reportLocationMode,
    setReportLocationMode,
    updateReportDraft,
  ])

  useEffect(() => {
    if (!reportLocationMode) {
      void mapManager.setReportPickMode(false)
      return
    }
    void mapManager.setReportPickMode(true, (coords) => {
      updateReportDraft({ coordinates: coords })
      setReportLocationMode(false)
      toast.success("Location selected")
    })
  }, [reportLocationMode, setReportLocationMode, updateReportDraft])

  useEffect(() => {
    mapManager.setBarrierClickHandler((barrierId) => {
      const match = candidateIndex.get(barrierId)
      if (!match) return

      setSelectedBarrier(match)

      if (activeMode !== "analyze" || currentView !== "BarrierDetails") {
        setActiveMode("analyze")
        window.setTimeout(() => {
          resetNav("AnalyzeResults")
          pushView("BarrierDetails")
        }, 0)
      }
    })

    return () => {
      mapManager.setBarrierClickHandler(null)
    }
  }, [activeMode, candidateIndex, currentView, pushView, resetNav, setActiveMode, setSelectedBarrier])

  useEffect(() => {
    mapManager.setReportClickHandler((reportId) => {
      const match =
        nearbyReports.find((report) => report.report_id === reportId) ??
        mapManager.getReportById(reportId)
      if (!match) return

      setSelectedReport(match)

      if (activeMode !== "search" || currentView !== "ReportDetails") {
        setActiveMode("search")
        window.setTimeout(() => {
          resetNav("SearchResults")
          pushView("ReportDetails")
        }, 0)
      }
    })

    return () => {
      mapManager.setReportClickHandler(null)
    }
  }, [
    activeMode,
    currentView,
    nearbyReports,
    pushView,
    resetNav,
    setActiveMode,
    setSelectedReport,
  ])

  const handleMapTypeSelection = async (type: MapType) => {
    const ok = await mapManager.setStyle(type)
    if (!ok) {
      toast.error("Not configured")
      await mapManager.setStyle("standard")
      setMapType("standard")
      return
    }
    setMapType(type)
  }

  const handleLocateUser = async () => {
    if (!navigator.geolocation) {
      toast.error("Geolocation is not supported in this browser")
      return
    }
    if (locating) return

    setLocating(true)
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 30000,
        })
      })

      const coords: [number, number] = [position.coords.longitude, position.coords.latitude]
      await mapManager.setUserLocation(coords, position.coords.accuracy)
      setUserLocation(coords)
      await mapManager.flyTo({ center: coords, zoom: 14 })
      toast.success("Centered on your location")
    } catch {
      toast.error("Could not access your location")
    } finally {
      setLocating(false)
    }
  }

  return (
    <div className="relative flex-1 h-full overflow-hidden z-0">
      <div
        id="map"
        className="absolute inset-0 z-0"
        style={{ backgroundColor: "transparent" }}
      />

      <div className="absolute top-3 right-3 z-10 flex flex-col gap-2.5">
        <div className="flex flex-col rounded-[14px] bg-white/80 backdrop-blur-xl shadow-[0_1px_6px_rgba(0,0,0,0.08)] border border-white/60 overflow-hidden">
          <button
            onClick={() => setShowMapTypes(!showMapTypes)}
            className="flex h-[38px] w-[38px] items-center justify-center hover:bg-[#767680]/[0.08] transition-colors duration-150"
            aria-label="Map type"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#6E6E73" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
              <line x1="8" y1="2" x2="8" y2="18" />
              <line x1="16" y1="6" x2="16" y2="22" />
            </svg>
          </button>
          <div className="h-px w-[24px] mx-auto bg-black/[0.08]" />
          <button
            onClick={() => void handleLocateUser()}
            disabled={locating}
            className="flex h-[38px] w-[38px] items-center justify-center hover:bg-[#767680]/[0.08] transition-colors duration-150"
            aria-label="Locate me"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6E6E73" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="3 11 22 2 13 21 11 13 3 11" />
            </svg>
          </button>
        </div>

        {showMapTypes && (
          <div
            className="popover-enter absolute top-0 right-[calc(100%+10px)] rounded-[14px] shadow-[0_8px_30px_rgba(0,0,0,0.12)] border border-white/60 p-2 flex gap-1.5"
            style={{
              background: "rgba(255,255,255,0.88)",
              backdropFilter: "blur(40px) saturate(1.4)",
              WebkitBackdropFilter: "blur(40px) saturate(1.4)",
            }}
          >
            {(["standard", "hybrid", "satellite"] as MapType[]).map((type) => {
              const isSelected = mapType === type
              return (
                <button
                  key={type}
                  onClick={() => void handleMapTypeSelection(type)}
                  className={`flex flex-col items-center gap-1.5 rounded-[10px] p-1.5 transition-all duration-120 ${
                    isSelected
                      ? "ring-[2.5px] ring-[#007AFF] bg-[#007AFF]/[0.06]"
                      : "hover:bg-[#767680]/[0.08]"
                  }`}
                >
                  <div
                    className="h-[52px] w-[52px] rounded-[8px] border border-black/[0.06]"
                    style={{
                      backgroundColor:
                        type === "standard" ? "#EEF0E8"
                        : type === "hybrid" ? "#7B8A6A"
                        : "#5A7247",
                    }}
                  />
                  <span className={`text-[11px] font-medium ${isSelected ? "text-[#007AFF]" : "text-[#1D1D1F]"}`}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="absolute bottom-12 right-3 z-10">
        <div className="flex flex-col rounded-[10px] bg-white/80 backdrop-blur-xl shadow-[0_1px_6px_rgba(0,0,0,0.08)] border border-white/60 overflow-hidden">
          <button
            onClick={() => void mapManager.zoomIn()}
            className="flex h-[36px] w-[36px] items-center justify-center text-[#6E6E73] hover:bg-[#767680]/[0.08] hover:text-[#1D1D1F] transition-colors duration-150"
            aria-label="Zoom in"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
          </button>
          <div className="h-px bg-black/[0.06] mx-2" />
          <button
            onClick={() => void mapManager.zoomOut()}
            className="flex h-[36px] w-[36px] items-center justify-center text-[#6E6E73] hover:bg-[#767680]/[0.08] hover:text-[#1D1D1F] transition-colors duration-150"
            aria-label="Zoom out"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
          </button>
        </div>
      </div>

      <div className="absolute bottom-3 right-3 flex items-center gap-3 text-[11px] font-medium text-[#86868B]/60">
        <span>Privacy</span>
        <span>Terms</span>
        <span>Legal</span>
        <span>Imagery</span>
      </div>
    </div>
  )
}
