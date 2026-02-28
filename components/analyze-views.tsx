"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { useAppState, type BBox } from "@/lib/app-context"
import { analyze, getReports, getResult } from "@/lib/api/client"
import { candidatesFromAnalyzeResult } from "@/lib/barrier-candidate"
import { copyTextToClipboard } from "@/lib/clipboard"
import { mapManager } from "@/lib/map/manager"
import { haversineMeters } from "@/lib/haversine"
import { formatDistanceMeters } from "@/lib/format-distance"
import { PanelHeader } from "@/components/panel-header"
import { MetricCard, SelectPill } from "@/components/view-helpers"
import {
  Loader2,
  Check,
  ChevronDown,
  SlidersHorizontal,
  ArrowUpDown,
  Link2,
  Flag,
  AlertTriangle,
  ChevronRight,
} from "lucide-react"

const barrierTypeIcons: Record<string, typeof AlertTriangle> = {
  stairs: AlertTriangle,
  raised_kerb: AlertTriangle,
  steep_incline: AlertTriangle,
  rough_surface: AlertTriangle,
  wheelchair_no: AlertTriangle,
  wheelchair_limited: AlertTriangle,
  access_no: AlertTriangle,
  report: AlertTriangle,
  other: AlertTriangle,
}

const barrierTypeColors: Record<string, string> = {
  stairs: "#FF6B35",
  raised_kerb: "#007AFF",
  steep_incline: "#A855F7",
  rough_surface: "#F59E0B",
  wheelchair_no: "#DC2626",
  wheelchair_limited: "#F59E0B",
  access_no: "#DC2626",
  report: "#DC2626",
  other: "#6B7280",
}

const confidenceColors: Record<string, { bg: string; text: string }> = {
  high: { bg: "#34C759", text: "#FFFFFF" },
  medium: { bg: "#FF9F0A", text: "#FFFFFF" },
  low: { bg: "#FF3B30", text: "#FFFFFF" },
}

const LOADING_STEPS = [
  "Fetching OSM data...",
  "Computing accessibility graph...",
  "Ranking blockers and map overlays...",
]

function formatScoreDelta(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0.0"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}`
}

function blockerTypeLabel(type: string) {
  if (type === "stairs") return "Stairs"
  if (type === "raised_kerb") return "Raised kerb"
  if (type === "steep_incline") return "Steep incline"
  if (type === "rough_surface") return "Rough surface"
  if (type === "wheelchair_no") return "Wheelchair=no"
  if (type === "wheelchair_limited") return "Wheelchair=limited"
  if (type === "access_no") return "Access restricted"
  if (type === "report") return "Report-derived blocker"
  return "Mobility blocker"
}

function mapStepToIndex(step: string) {
  const normalized = step.toLowerCase()
  if (normalized.includes("fetch")) return 0
  if (normalized.includes("graph") || normalized.includes("build") || normalized.includes("rank")) return 1
  if (normalized.includes("cache") || normalized.includes("saving") || normalized.includes("complete")) return 2
  return 0
}

function isPointInBbox(lng: number, lat: number, bbox: BBox) {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
}

export function AnalyzeSetup() {
  const {
    setBbox,
    pushView,
    setAnalysisAnchor,
    setAnalysisAnchorPoiId,
    setAnalysisStatus,
    setCurrentStep,
    setAnalysisJobId,
    setAnalysisPayload,
  } = useAppState()

  const handleAnalyze = () => {
    const viewBbox = mapManager.getCurrentViewBBox()
    if (!viewBbox) {
      toast.error("Map view is not ready yet")
      return
    }
    setBbox(viewBbox)
    void mapManager.setBBoxDisplayMode("outline")
    setAnalysisAnchor(null)
    setAnalysisAnchorPoiId(null)
    setAnalysisJobId(null)
    setAnalysisPayload(null)
    setAnalysisStatus("loading")
    setCurrentStep(0)
    window.setTimeout(() => {
      pushView("AnalyzeLoading")
    }, 0)
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="Analyze" />
      <div className="flex-1 overflow-y-auto panel-scroll px-4 pb-6">
        <div className="pt-4 mb-4 rounded-[20px] bg-white/90 p-4 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
          <p className="text-[14px] font-medium text-[#1D1D1F] mb-1">Analyze Current Map View</p>
          <p className="text-[13px] font-normal text-[#86868B]">
            POI click analysis is preferred. You can also run a manual accessibility scan on the current view.
          </p>
        </div>

        <button
          onClick={handleAnalyze}
          className="w-full h-[48px] rounded-[16px] text-[15px] font-semibold transition-all duration-150 bg-[#007AFF] text-white hover:bg-[#0066DD] shadow-[0_4px_14px_rgba(0,122,255,0.2)]"
        >
          Analyze Current View
        </button>
      </div>
    </div>
  )
}

export function AnalyzeLoading() {
  const {
    bboxSelected,
    analysisAnchor,
    analysisAnchorPoiId,
    setAnalysisStatus,
    setCurrentStep,
    currentStep,
    setCandidates,
    setAnalysisJobId,
    setAnalysisPayload,
    pushView,
  } = useAppState()

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (!bboxSelected) {
        setAnalysisStatus("error")
        toast.error("Current map view is not ready. Try Analyze again.")
        return
      }

      try {
        setCurrentStep(0)
        const { job_id } = await analyze(bboxSelected, analysisAnchor, analysisAnchorPoiId)
        if (cancelled) return
        setAnalysisJobId(job_id)

        while (!cancelled) {
          const result = await getResult(job_id)
          if ("status" in result) {
            setCurrentStep(mapStepToIndex(result.step))
            await new Promise((resolve) => setTimeout(resolve, 1000))
            continue
          }

          let reports = [] as Awaited<ReturnType<typeof getReports>>["reports"]
          try {
            const reportsResponse = await getReports()
            reports = reportsResponse.reports
          } catch (error) {
            console.warn("[analyze] failed to load report confidence context", error)
          }

          setCandidates(candidatesFromAnalyzeResult(result, reports))
          setAnalysisPayload(result)
          await mapManager.setAnalysisData(result)
          setAnalysisStatus("done")
          setCurrentStep(3)

          const warning = result.meta.warnings[0]
          if (warning) toast.message(warning)

          pushView("AnalyzeResults")
          return
        }
      } catch (error) {
        if (cancelled) return
        setAnalysisStatus("error")
        toast.error(error instanceof Error ? error.message : "Analysis failed")
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [
    bboxSelected,
    analysisAnchor,
    analysisAnchorPoiId,
    pushView,
    setAnalysisJobId,
    setAnalysisPayload,
    setAnalysisStatus,
    setCandidates,
    setCurrentStep,
  ])

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="Analyzing" />
      <div className="flex-1 overflow-y-auto panel-scroll px-4 pb-6 pt-6">
        <div className="flex flex-col gap-4">
          {LOADING_STEPS.map((label, i) => {
            const isDone = currentStep > i
            const isCurrent = currentStep === i
            return (
              <div key={i} className="flex items-center gap-3">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full flex-shrink-0 transition-colors duration-200 ${
                    isDone
                      ? "bg-[#34C759]/15"
                      : isCurrent
                      ? "bg-[#007AFF]/10"
                      : "bg-[#F2F2F7]"
                  }`}
                >
                  {isDone ? (
                    <Check className="h-3.5 w-3.5 text-[#34C759]" strokeWidth={2.5} />
                  ) : isCurrent ? (
                    <Loader2 className="h-3.5 w-3.5 text-[#007AFF] animate-spin" strokeWidth={2} />
                  ) : (
                    <span className="text-[12px] text-[#86868B] font-medium">{i + 1}</span>
                  )}
                </div>
                <span
                  className={`text-[15px] transition-colors duration-200 ${
                    isDone
                      ? "text-[#34C759] font-medium"
                      : isCurrent
                      ? "text-[#1D1D1F] font-medium"
                      : "text-[#86868B] font-normal"
                  }`}
                >
                  {label}
                </span>
              </div>
            )
          })}
        </div>

        <div className="mt-8 flex flex-col gap-2.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-[20px] bg-white/50 p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-black/[0.06]" />
                <div className="flex-1">
                  <div className="h-3 w-3/4 rounded-md bg-black/[0.06] mb-2" />
                  <div className="h-2.5 w-1/2 rounded-md bg-black/[0.06]" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function AnalyzeResults() {
  const {
    candidates,
    userLocation,
    radius,
    setRadius,
    sortBy,
    setSortBy,
    filterTypes,
    setFilterTypes,
    filterConfidence,
    setFilterConfidence,
    setSelectedBarrier,
    pushView,
  } = useAppState()
  const [showFilters, setShowFilters] = useState(false)
  const [viewportBBox, setViewportBBox] = useState<BBox | null>(null)

  useEffect(() => {
    return mapManager.subscribeViewChange((bbox) => {
      setViewportBBox(bbox)
    })
  }, [])

  const radiusMeters = useMemo(() => {
    if (radius === "500m") return 500
    if (radius === "1000m") return 1000
    if (radius === "5000m") return 5000
    if (radius === "20000m") return 20000
    return null
  }, [radius])

  const ranked = useMemo(() => {
    const confidenceRank: Record<string, number> = { high: 3, medium: 2, low: 1 }

    const filtered = candidates.filter((candidate) => {
      const userDistance = userLocation
        ? haversineMeters(userLocation, [candidate.lng, candidate.lat])
        : null
      const withinRadius =
        radius === "viewport"
          ? viewportBBox
            ? isPointInBbox(candidate.lng, candidate.lat, viewportBBox)
            : true
          : radiusMeters === null || (userDistance !== null && userDistance <= radiusMeters)
      const typeMatch = filterTypes.length === 0 || filterTypes.includes(candidate.type)
      const confidenceMatch =
        filterConfidence.length === 0 || filterConfidence.includes(candidate.confidence)
      return withinRadius && typeMatch && confidenceMatch
    })

    return [...filtered].sort((a, b) => {
      if (sortBy === "impact") return b.score - a.score || b.deltaGeneral - a.deltaGeneral
      if (sortBy === "distance") {
        const aDistance = userLocation
          ? haversineMeters(userLocation, [a.lng, a.lat])
          : Number.POSITIVE_INFINITY
        const bDistance = userLocation
          ? haversineMeters(userLocation, [b.lng, b.lat])
          : Number.POSITIVE_INFINITY
        return aDistance - bDistance
      }
      if (sortBy === "confidence") return confidenceRank[b.confidence] - confidenceRank[a.confidence]
      return 0
    })
  }, [candidates, filterConfidence, filterTypes, radius, radiusMeters, sortBy, userLocation, viewportBBox])

  const toggleType = (type: string) => {
    if (filterTypes.includes(type)) {
      setFilterTypes(filterTypes.filter((value) => value !== type))
      return
    }
    setFilterTypes([...filterTypes, type])
  }

  const toggleConfidence = (confidence: string) => {
    if (filterConfidence.includes(confidence)) {
      setFilterConfidence(filterConfidence.filter((value) => value !== confidence))
      return
    }
    setFilterConfidence([...filterConfidence, confidence])
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="Top Access Blockers" />
      <div className="flex-1 overflow-y-auto panel-scroll px-4 pb-6">
        <p className="text-[13px] font-normal text-[#86868B] pt-3 pb-2 px-1">
          {radius === "viewport"
            ? "Within current viewport"
            : `Within ${
                radius === "500m"
                  ? "500 m"
                  : radius === "1000m"
                  ? "1 km"
                  : radius === "5000m"
                  ? "5 km"
                  : "20 km"
              } of your location`}
        </p>

        <div className="flex items-center gap-2 mb-4">
          <SelectPill
            value={radius}
            onChange={setRadius}
            options={[
              { value: "viewport", label: "Viewport" },
              { value: "500m", label: "500 m" },
              { value: "1000m", label: "1 km" },
              { value: "5000m", label: "5 km" },
              { value: "20000m", label: "20 km" },
            ]}
            icon={<ChevronDown className="h-3 w-3" />}
          />
          <SelectPill
            value={sortBy}
            onChange={setSortBy}
            options={[
              { value: "impact", label: "Impact" },
              { value: "confidence", label: "Confidence" },
              { value: "distance", label: "Distance" },
            ]}
            icon={<ArrowUpDown className="h-3 w-3" />}
          />
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex h-[32px] items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] font-medium transition-colors duration-150 ${
              showFilters
                ? "bg-[#007AFF] text-white"
                : "bg-white/90 text-[#1D1D1F] shadow-[0_1px_3px_rgba(0,0,0,0.06)] hover:bg-white"
            }`}
          >
            <SlidersHorizontal className="h-3 w-3" strokeWidth={2} />
            Filter
          </button>
        </div>

        {showFilters && (
          <div className="popover-enter mb-4 rounded-[18px] bg-white/90 p-4 shadow-[0_4px_16px_rgba(0,0,0,0.08)] border border-black/[0.04]">
            <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">Type</p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {[
                { label: "Stairs", value: "stairs" },
                { label: "Raised kerb", value: "raised_kerb" },
                { label: "Steep incline", value: "steep_incline" },
                { label: "Rough surface", value: "rough_surface" },
                { label: "Wheelchair=no", value: "wheelchair_no" },
                { label: "Access restricted", value: "access_no" },
                { label: "Report-derived", value: "report" },
              ].map((item) => (
                <button
                  key={item.value}
                  onClick={() => toggleType(item.value)}
                  className={`h-[28px] rounded-[10px] px-3 text-[12px] font-medium transition-colors ${
                    filterTypes.includes(item.value)
                      ? "bg-[#007AFF] text-white"
                      : "bg-[#F2F2F7] text-[#1D1D1F] hover:bg-[#E5E5EA]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">Confidence</p>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: "High", value: "high" },
                { label: "Medium", value: "medium" },
                { label: "Low", value: "low" },
              ].map((item) => (
                <button
                  key={item.value}
                  onClick={() => toggleConfidence(item.value)}
                  className={`h-[28px] rounded-[10px] px-3 text-[12px] font-medium transition-colors ${
                    filterConfidence.includes(item.value)
                      ? "bg-[#007AFF] text-white"
                      : "bg-[#F2F2F7] text-[#1D1D1F] hover:bg-[#E5E5EA]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {ranked.map((barrier) => {
            const Icon = barrierTypeIcons[barrier.type] || AlertTriangle
            const color = barrierTypeColors[barrier.type] || "#86868B"
            const conf = confidenceColors[barrier.confidence]
            const userDistance = userLocation
              ? haversineMeters(userLocation, [barrier.lng, barrier.lat])
              : null
            return (
              <button
                key={barrier.id}
                onClick={() => {
                  setSelectedBarrier(barrier)
                  void mapManager.focusBarrier(barrier.id, [barrier.lng, barrier.lat], 13.5)
                  pushView("BarrierDetails")
                }}
                className="pill-press flex items-center gap-3 rounded-[20px] bg-white/90 px-4 py-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.04)] hover:bg-white transition-colors duration-150 text-left"
              >
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-full flex-shrink-0"
                  style={{ backgroundColor: `${color}12` }}
                >
                  <Icon className="h-[15px] w-[15px]" style={{ color }} strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-medium text-[#1D1D1F] truncate">
                    {barrier.name || blockerTypeLabel(barrier.type)}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[12px] font-semibold text-[#34C759]">
                      +{formatDistanceMeters(barrier.gain)} unlock
                    </span>
                    <span
                      className="text-[12px] font-normal"
                      style={{ color: userDistance === null ? "#8E8E93" : "#007AFF" }}
                    >
                      {formatDistanceMeters(userDistance)}
                    </span>
                    <span className="text-[12px] font-semibold text-[#0A84FF]">
                      Delta {formatScoreDelta(barrier.deltaGeneral)}
                    </span>
                    <span
                      className="inline-flex h-[18px] items-center rounded-[6px] px-1.5 text-[10px] font-semibold uppercase tracking-wide"
                      style={{ backgroundColor: conf.bg, color: conf.text }}
                    >
                      {barrier.confidence}
                    </span>
                  </div>
                </div>
                <ChevronRight className="h-[14px] w-[14px] text-[#C7C7CC] flex-shrink-0" strokeWidth={2} />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function BarrierDetails() {
  const {
    selectedBarrier,
    analysisPayload,
    userLocation,
    setActiveMode,
    resetNav,
    resetReportDraft,
    updateReportDraft,
    setReportLocationMode,
  } = useAppState()
  const [showProvenance, setShowProvenance] = useState(false)

  if (!selectedBarrier) return null

  const b = selectedBarrier
  const Icon = barrierTypeIcons[b.type] || AlertTriangle
  const color = barrierTypeColors[b.type] || "#86868B"
  const conf = confidenceColors[b.confidence]
  const distanceFromUser = userLocation ? haversineMeters(userLocation, [b.lng, b.lat]) : null
  const calculationMethod =
    b.calculationMethod ??
    analysisPayload?.meta.calculation_method ??
    "General accessibility scoring based on network continuity and reachable opportunities."
  const osmIdDisplay = b.osmId.startsWith("way/") ? b.osmId.split("/")[1] ?? "N/A" : "N/A"
  const isReportBarrier = b.type === "report"
  const reportsDisplay =
    typeof b.reportCount === "number" && Number.isFinite(b.reportCount)
      ? String(Math.max(0, Math.round(b.reportCount)))
      : "N/A"
  const renouncementsDisplay =
    typeof b.renouncements === "number" && Number.isFinite(b.renouncements)
      ? String(Math.max(0, Math.round(b.renouncements)))
      : "N/A"

  const handleCopyLink = async () => {
    try {
      const url = new URL(window.location.href)
      url.search = ""
      url.searchParams.set(
        "barrier_payload",
        JSON.stringify({
          barrier: {
            ...b,
            calculationMethod,
          },
        })
      )
      await copyTextToClipboard(url.toString())
      toast.success("Barrier link copied")
    } catch {
      toast.error("Failed to copy barrier link")
    }
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={b.name} />
      <div className="flex-1 overflow-y-auto panel-scroll px-4 pb-6">
        <div className="flex items-center gap-2.5 pt-4 mb-4">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: `${color}12` }}
          >
            <Icon className="h-[18px] w-[18px]" style={{ color }} strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-[13px] font-medium text-[#86868B] capitalize">{blockerTypeLabel(b.type)}</p>
            <span
              className="inline-flex h-[18px] items-center rounded-[6px] px-1.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ backgroundColor: conf.bg, color: conf.text }}
            >
              {b.confidence} confidence
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          <MetricCard label="Accessible unlock" value={`+${formatDistanceMeters(b.gain)}`} accent="#34C759" />
          {isReportBarrier ? (
            <MetricCard label="Reports" value={reportsDisplay} accent="#34C759" />
          ) : (
            <MetricCard label="Blocked segment" value={formatDistanceMeters(b.upstreamBlocked)} accent="#FF9F0A" />
          )}
          <MetricCard
            label="Distance"
            value={formatDistanceMeters(distanceFromUser)}
            accent={distanceFromUser === null ? "#8E8E93" : "#007AFF"}
          />
          <MetricCard label="General index Delta" value={formatScoreDelta(b.deltaGeneral)} accent="#0A84FF" />
          <MetricCard label="NAS Delta" value={formatScoreDelta(b.deltaNas)} accent="#5856D6" />
          <MetricCard label="OAS Delta" value={formatScoreDelta(b.deltaOas)} accent="#14B8A6" />
          <MetricCard label="Destinations unlocked" value={String(b.unlockedPoiCount)} accent="#0A84FF" />
          {isReportBarrier ? (
            <MetricCard label="Renouncements" value={renouncementsDisplay} accent="#FF3B30" />
          ) : (
            <MetricCard label="OSM ID" value={osmIdDisplay} accent="#8E8E93" />
          )}
        </div>

        <div className="rounded-[20px] bg-white/90 p-4 shadow-[0_1px_4px_rgba(0,0,0,0.04)] mb-4">
          <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">
            Calculation method
          </p>
          <p className="text-[13px] font-normal text-[#1D1D1F]">{calculationMethod}</p>
        </div>

        <div className="rounded-[20px] bg-white/90 p-4 shadow-[0_1px_4px_rgba(0,0,0,0.04)] mb-4">
          <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">Why this confidence?</p>
          <ul className="flex flex-col gap-1.5">
            {b.inferredSignals.map((sig, i) => (
              <li key={i} className="flex items-start gap-2 text-[14px] font-normal text-[#1D1D1F]">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[#007AFF] flex-shrink-0" />
                {sig}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => {
              void handleCopyLink()
            }}
            className="flex-1 flex items-center justify-center gap-1.5 h-[40px] rounded-[14px] bg-white/90 text-[13px] font-medium text-[#1D1D1F] shadow-[0_1px_4px_rgba(0,0,0,0.04)] hover:bg-white transition-colors duration-150"
          >
            <Link2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            Copy link
          </button>
          <button
            onClick={() => {
              resetReportDraft()
              updateReportDraft({
                barrierId: b.id,
                coordinates: null,
              })
              setReportLocationMode(false)
              setActiveMode("report")
              window.setTimeout(() => {
                resetNav("ReportForm")
              }, 0)
            }}
            className="flex-1 flex items-center justify-center gap-1.5 h-[40px] rounded-[14px] bg-white/90 text-[13px] font-medium text-[#1D1D1F] shadow-[0_1px_4px_rgba(0,0,0,0.04)] hover:bg-white transition-colors duration-150"
          >
            <Flag className="h-3.5 w-3.5" strokeWidth={1.5} />
            Report barrier
          </button>
        </div>

        <button
          onClick={() => setShowProvenance(!showProvenance)}
          className="flex items-center justify-between w-full rounded-[20px] bg-white/90 px-4 py-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.04)] mb-2 transition-colors duration-150 hover:bg-white"
        >
          <span className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em]">Data provenance</span>
          <ChevronDown
            className={`h-4 w-4 text-[#C7C7CC] transition-transform duration-200 ${
              showProvenance ? "rotate-180" : ""
            }`}
            strokeWidth={2}
          />
        </button>
        {showProvenance && (
          <div className="popover-enter rounded-[20px] bg-white/90 px-4 py-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
            {isReportBarrier ? (
              <>
                <p className="text-[12px] text-[#86868B] mb-1 font-medium">Reports</p>
                <p className="text-[13px] text-[#1D1D1F] font-mono mb-3">{reportsDisplay}</p>
                <p className="text-[12px] text-[#86868B] mb-1 font-medium">Renouncements</p>
                <p className="text-[13px] text-[#1D1D1F] font-mono mb-3">{renouncementsDisplay}</p>
              </>
            ) : (
              <>
                <p className="text-[12px] text-[#86868B] mb-1 font-medium">OSM ID</p>
                <p className="text-[13px] text-[#1D1D1F] font-mono mb-3">{b.osmId}</p>
              </>
            )}
            <p className="text-[12px] text-[#86868B] mb-1 font-medium">Calculation method</p>
            <p className="text-[12px] text-[#1D1D1F] mb-3">{calculationMethod}</p>
            <p className="text-[12px] text-[#86868B] mb-1 font-medium">Tags</p>
            <div className="flex flex-wrap gap-1 mb-3">
              {Object.entries(b.tags).map(([k, v]) => (
                <span key={k} className="rounded-[8px] bg-[#F2F2F7] px-2 py-0.5 text-[11px] font-mono text-[#1D1D1F]">
                  {k}={v}
                </span>
              ))}
            </div>
            <p className="text-[12px] text-[#86868B] mb-1 font-medium">Inferred signals</p>
            <ul className="flex flex-col gap-1">
              {b.inferredSignals.map((s, i) => (
                <li key={i} className="text-[12px] font-normal text-[#1D1D1F]">
                  {"- "}{s}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
