"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { useAppState, type MockLocation } from "@/lib/app-context"
import { getReports, submitReportFeedback, search as searchApi, type ReportRecord } from "@/lib/api/client"
import { copyTextToClipboard } from "@/lib/clipboard"
import { mapManager } from "@/lib/map/manager"
import { reportDisplayId } from "@/lib/report-id"
import { haversineKm } from "@/lib/haversine"
import { PanelHeader } from "@/components/panel-header"
import { MetricCard, SelectPill } from "@/components/view-helpers"
import {
  Search,
  MapPin,
  AlertTriangle,
  Crosshair,
  Clock,
  Link2,
  ChevronDown,
  ArrowUpDown,
  ChevronRight,
} from "lucide-react"

const findNearbyItems = [
  { key: "barriers", label: "Nearby Barriers", icon: AlertTriangle, bgColor: "#FF9500", iconColor: "#FFFFFF" },
  { key: "reports", label: "Nearby Reports", icon: MapPin, bgColor: "#FF3B30", iconColor: "#FFFFFF" },
  { key: "high-impact", label: "High-impact Candidates", icon: Crosshair, bgColor: "#007AFF", iconColor: "#FFFFFF" },
]

const reportConfidenceColors: Record<ReportRecord["confidence"], { bg: string; text: string; rank: number }> = {
  high: { bg: "#34C759", text: "#FFFFFF", rank: 3 },
  medium: { bg: "#FF9F0A", text: "#FFFFFF", rank: 2 },
  low: { bg: "#FF3B30", text: "#FFFFFF", rank: 1 },
}

function toLocation(result: {
  display_name: string
  lat: number
  lon: number
  bbox: [number, number, number, number]
  type: string
}, index: number): MockLocation {
  const segments = result.display_name.split(",").map((item) => item.trim())
  const name = segments[0] || result.display_name
  const subtitle = segments.slice(1, 3).join(", ") || result.type
  return {
    id: `${result.lon}:${result.lat}:${index}`,
    name,
    subtitle,
    lat: result.lat,
    lng: result.lon,
    bbox: result.bbox,
    type: result.type,
    displayName: result.display_name,
  }
}

export function SearchHome() {
  const {
    pushView,
    addRecentSearch,
    setSelectedLocation,
    setActiveMode,
    resetNav,
    setSortBy,
    setFilterTypes,
    setBbox,
    setAnalysisStatus,
    setCurrentStep,
    setAnalysisJobId,
    setAnalysisPayload,
    setNearbyReports,
    setSelectedReport,
    candidates,
    recentSearches,
    searchResults,
    setSearchResults,
    searchQuery,
    setSearchQuery,
  } = useAppState()
  const [isFocused, setIsFocused] = useState(false)
  const query = searchQuery

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setSearchResults([])
      return
    }

    const timer = window.setTimeout(async () => {
      try {
        const response = await searchApi(trimmed)
        setSearchResults(response.map(toLocation))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Search failed")
      }
    }, 250)

    return () => {
      window.clearTimeout(timer)
    }
  }, [query, setSearchResults])

  const filteredLocations = searchResults

  const openResult = (location: MockLocation) => {
    setSelectedLocation(location)
    addRecentSearch(location.name, location.subtitle)
    void mapManager.flyTo({
      bbox: location.bbox ?? undefined,
      center: [location.lng, location.lat],
      zoom: 12.5,
    })
    pushView("SearchResults")
  }

  const openRecent = async (item: { query: string; subtitle: string }) => {
    setSearchQuery(item.query)
    try {
      const response = await searchApi(item.query)
      setSearchResults(response.map(toLocation))
      pushView("SearchResults")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Search failed")
    }
  }

  const openNearbyCandidates = (type: "barriers" | "high-impact") => {
    if (candidates.length === 0) {
      toast.message("Run an analysis first to see nearby candidates")
      return
    }

    setActiveMode("analyze")
    resetNav("AnalyzeResults")
    setSortBy("impact")
    if (type === "barriers") {
      setFilterTypes(["dam", "weir", "waterfall"])
    } else {
      setFilterTypes([])
    }
  }

  const openNearbyReports = async () => {
    try {
      const bbox = mapManager.getCurrentViewBBox() ?? undefined
      const response = await getReports(bbox)
      const locationReports = response.reports.filter((report) => !report.barrier_id)
      setNearbyReports(locationReports)
      setSelectedReport(null)
      await mapManager.setReportsData(locationReports)
      const withCoordinates = locationReports.filter(
        (report): report is (typeof report & { coordinates: [number, number] }) =>
          Array.isArray(report.coordinates) && report.coordinates.length === 2
      )
      if (withCoordinates.length === 0) {
        toast.message("No nearby reports found")
        return
      }

      const reportLocations: MockLocation[] = withCoordinates.map((report) => {
        const coordinates = report.coordinates
        const description = report.description.length > 60
          ? `${report.description.slice(0, 57)}...`
          : report.description
        return {
          id: report.report_id,
          name: report.category || "Report",
          subtitle: `${description || "User-submitted report"} - ${report.confidence.toUpperCase()} confidence`,
          lat: coordinates[1],
          lng: coordinates[0],
          bbox: null,
          type: "report",
          displayName: report.category || "Report",
        }
      })

      setSearchResults(reportLocations)
      pushView("SearchResults")
      toast.success(`Loaded ${reportLocations.length} nearby reports`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to fetch nearby reports")
    }
  }

  const startAnalyzeFromCurrentView = () => {
    const bbox = mapManager.getCurrentViewBBox()
    if (!bbox) {
      toast.error("Map view is not ready yet")
      return
    }
    setBbox(bbox)
    void mapManager.setBBoxDisplayMode("outline")
    setAnalysisJobId(null)
    setAnalysisPayload(null)
    setAnalysisStatus("loading")
    setCurrentStep(0)
    setActiveMode("analyze")
    window.setTimeout(() => {
      resetNav("AnalyzeLoading")
    }, 0)
  }

  const handleFindNearby = async (key: string) => {
    if (key === "reports") {
      await openNearbyReports()
      return
    }
    if (key === "barriers") {
      startAnalyzeFromCurrentView()
      return
    }
    openNearbyCandidates("high-impact")
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="Search" />
      <div className="flex-1 overflow-y-auto panel-scroll">
        <div className="px-4 pt-3 pb-1">
          <div
            className={`flex items-center gap-2.5 rounded-xl border bg-white px-3.5 h-[38px] transition-all duration-150 ${
              isFocused
                ? "border-[#007AFF] shadow-[0_0_0_3px_rgba(0,122,255,0.15)]"
                : "border-[#007AFF]/40"
            }`}
          >
            <Search className="h-[15px] w-[15px] text-[#86868B] flex-shrink-0" strokeWidth={1.8} />
            <input
              type="text"
              placeholder="Search places to analyze..."
              value={query}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && query.trim()) {
                  addRecentSearch(query.trim(), "Search query")
                  pushView("SearchResults")
                }
              }}
              className="flex-1 bg-transparent text-[15px] font-normal text-[#1D1D1F] placeholder:text-[#86868B] outline-none"
            />
          </div>
        </div>

        {filteredLocations.length > 0 && (
          <div className="px-4 mb-4">
            <div className="rounded-xl bg-white border border-black/[0.06] overflow-hidden">
              {filteredLocations.map((loc, i) => (
                <button
                  key={loc.id}
                  onClick={() => openResult(loc)}
                  className={`flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-[#767680]/[0.06] transition-colors duration-100 ${
                    i < filteredLocations.length - 1 ? "border-b border-black/[0.06]" : ""
                  }`}
                >
                  <div className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#007AFF] flex-shrink-0">
                    <MapPin className="h-[14px] w-[14px] text-white" strokeWidth={1.8} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-normal text-[#1D1D1F] truncate">{loc.name}</p>
                    <p className="text-[13px] font-normal text-[#86868B] truncate">{loc.subtitle}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {query.length === 0 && recentSearches.length > 0 && (
          <div className="mt-5">
            <h3 className="text-[14px] font-semibold text-[#1D1D1F] px-5 mb-2.5">
              Recently Searched
            </h3>
            <div className="mx-4 rounded-xl bg-white border border-black/[0.06] overflow-hidden">
              {recentSearches.map((item, i) => (
                <button
                  key={`${item.query}-${i}`}
                  onClick={() => void openRecent(item)}
                  className={`flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-[#767680]/[0.06] transition-colors duration-100 ${
                    i < recentSearches.length - 1 ? "border-b border-black/[0.06]" : ""
                  }`}
                >
                  <div className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-[#F2F2F7] flex-shrink-0">
                    <Clock className="h-[13px] w-[13px] text-[#86868B]" strokeWidth={1.8} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-normal text-[#1D1D1F] truncate">{item.query}</p>
                    <p className="text-[13px] font-normal text-[#86868B] truncate">{item.subtitle}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {query.length === 0 && (
          <div className="mt-5">
            <h3 className="text-[14px] font-semibold text-[#1D1D1F] px-5 mb-2.5">
              Find Nearby
            </h3>
            <div className="mx-4 rounded-xl bg-white border border-black/[0.06] overflow-hidden">
              {findNearbyItems.map((item, i) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.label}
                    onClick={() => void handleFindNearby(item.key)}
                    className={`flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-[#767680]/[0.06] transition-colors duration-100 ${
                      i < findNearbyItems.length - 1 ? "border-b border-black/[0.06]" : ""
                    }`}
                  >
                    <div
                      className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] flex-shrink-0"
                      style={{ backgroundColor: item.bgColor }}
                    >
                      <Icon className="h-[15px] w-[15px]" style={{ color: item.iconColor }} strokeWidth={1.8} />
                    </div>
                    <span className="text-[15px] font-normal text-[#1D1D1F]">{item.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="pb-6" />
      </div>
    </div>
  )
}

export function SearchResults() {
  const {
    searchResults,
    nearbyReports,
    candidates,
    userLocation,
    setSelectedLocation,
    setSelectedBarrier,
    setSelectedReport,
    setActiveMode,
    resetNav,
    pushView,
  } = useAppState()
  const [reportSortBy, setReportSortBy] = useState<"confidence" | "distance">("confidence")
  const results = searchResults
  const reportById = useMemo(() => {
    const byId = new Map<string, ReportRecord>()
    for (const report of nearbyReports) {
      byId.set(report.report_id, report)
    }
    return byId
  }, [nearbyReports])

  const reportResults = useMemo(() => {
    return results
      .filter((loc) => loc.type === "report")
      .map((loc) => reportById.get(loc.id))
      .filter((report): report is ReportRecord => Boolean(report))
  }, [reportById, results])

  const showingReportResults = reportResults.length > 0 && reportResults.length === results.length

  const sortedReportResults = useMemo(() => {
    if (!showingReportResults) return []
    const copy = [...reportResults]
    copy.sort((a, b) => {
      if (reportSortBy === "confidence") {
        return reportConfidenceColors[b.confidence].rank - reportConfidenceColors[a.confidence].rank
      }
      const aDistance =
        userLocation && a.coordinates ? haversineKm(userLocation, a.coordinates) : Number.POSITIVE_INFINITY
      const bDistance =
        userLocation && b.coordinates ? haversineKm(userLocation, b.coordinates) : Number.POSITIVE_INFINITY
      return aDistance - bDistance
    })
    return copy
  }, [reportResults, reportSortBy, showingReportResults, userLocation])

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="Results" />
      <div className="flex-1 overflow-y-auto panel-scroll">
        <p className="text-[13px] font-normal text-[#86868B] pt-3 pb-2 px-5">
          {showingReportResults ? `${sortedReportResults.length} reports found` : `${results.length} locations found`}
        </p>
        {showingReportResults ? (
          <>
            <div className="flex items-center gap-2 px-4 mb-3">
              <SelectPill
                value={reportSortBy}
                onChange={(value) => setReportSortBy(value as "confidence" | "distance")}
                options={[
                  { value: "confidence", label: "Confidence" },
                  { value: "distance", label: "Distance" },
                ]}
                icon={reportSortBy === "confidence" ? <ChevronDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3" />}
              />
            </div>
            <div className="flex flex-col gap-2 px-4">
              {sortedReportResults.map((report) => {
                const conf = reportConfidenceColors[report.confidence]
                const distance =
                  userLocation && report.coordinates ? haversineKm(userLocation, report.coordinates) : null
                const description =
                  report.description.length > 56
                    ? `${report.description.slice(0, 53)}...`
                    : report.description

                return (
                  <button
                    key={report.report_id}
                    onClick={() => {
                      setSelectedReport(report)
                      if (report.coordinates) {
                        void mapManager.focusReport(report.report_id, report.coordinates, 13)
                      } else {
                        void mapManager.setSelectedReport(report.report_id)
                      }
                      setActiveMode("search")
                      window.setTimeout(() => {
                        resetNav("SearchResults")
                        pushView("ReportDetails")
                      }, 0)
                    }}
                    className="pill-press flex items-center gap-3 rounded-[20px] bg-white/90 px-4 py-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.04)] hover:bg-white transition-colors duration-150 text-left"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#FF3B30]/12 flex-shrink-0">
                      <AlertTriangle className="h-[15px] w-[15px] text-[#FF3B30]" strokeWidth={1.5} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-medium text-[#1D1D1F] truncate">
                        {report.category || "Report"}
                      </p>
                      <p className="text-[12px] font-normal text-[#86868B] truncate mb-0.5">{description}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-semibold text-[#34C759]">
                          {report.reports_count} reports
                        </span>
                        <span className="text-[12px] font-semibold text-[#FF3B30]">
                          {report.renouncements} renouncements
                        </span>
                        <span
                          className="text-[12px] font-normal"
                          style={{ color: distance === null ? "#8E8E93" : "#007AFF" }}
                        >
                          {distance === null ? "N/A" : `${distance.toFixed(1)} km`}
                        </span>
                        <span
                          className="inline-flex h-[18px] items-center rounded-[6px] px-1.5 text-[10px] font-semibold uppercase tracking-wide"
                          style={{ backgroundColor: conf.bg, color: conf.text }}
                        >
                          {report.confidence}
                        </span>
                      </div>
                    </div>
                    <ChevronRight className="h-[14px] w-[14px] text-[#C7C7CC] flex-shrink-0" strokeWidth={2} />
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <div className="mx-4 rounded-xl bg-white border border-black/[0.06] overflow-hidden">
              {results.map((loc, i) => (
                <button
                  key={loc.id}
                  onClick={() => {
                    setSelectedLocation(loc)
                    if (loc.type === "barrier") {
                      const match = candidates.find((candidate) => candidate.id === loc.id)
                      if (match) {
                        setSelectedBarrier(match)
                        void mapManager.focusBarrier(match.id, [match.lng, match.lat], 13.5)
                        setActiveMode("analyze")
                        window.setTimeout(() => {
                          resetNav("AnalyzeResults")
                          pushView("BarrierDetails")
                        }, 0)
                        return
                      }
                    }
                    if (loc.type === "report") {
                      const report = nearbyReports.find((item) => item.report_id === loc.id)
                      if (report) {
                        setSelectedReport(report)
                        if (report.coordinates) {
                          void mapManager.focusReport(report.report_id, report.coordinates, 13)
                        } else {
                          void mapManager.setSelectedReport(report.report_id)
                        }
                        setActiveMode("search")
                        window.setTimeout(() => {
                          resetNav("SearchResults")
                          pushView("ReportDetails")
                        }, 0)
                        return
                      }
                    }
                    void mapManager.flyTo({
                      bbox: loc.bbox ?? undefined,
                      center: [loc.lng, loc.lat],
                      zoom: 13,
                    })
                  }}
                  className={`flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-[#767680]/[0.06] transition-colors duration-100 ${
                    i < results.length - 1 ? "border-b border-black/[0.06]" : ""
                  }`}
                >
                  <div
                    className="flex h-[30px] w-[30px] items-center justify-center rounded-full flex-shrink-0"
                    style={{ backgroundColor: loc.type === "report" ? "#FF3B30" : "#007AFF" }}
                  >
                    <MapPin className="h-[14px] w-[14px] text-white" strokeWidth={1.8} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-normal text-[#1D1D1F] truncate">{loc.name}</p>
                    <p className="text-[13px] font-normal text-[#86868B] truncate">{loc.subtitle}</p>
                  </div>
                </button>
              ))}
            </div>

            <SelectedLocationCTA />
          </>
        )}

        <div className="pb-6" />
      </div>
    </div>
  )
}

export function ReportDetails() {
  const {
    selectedReport,
    userLocation,
    setSelectedReport,
    setNearbyReports,
    setSearchResults,
  } = useAppState()
  const [pendingAction, setPendingAction] = useState<"confirm" | "renounce" | null>(null)

  if (!selectedReport) return null

  const report = selectedReport
  const reportIdNumber = reportDisplayId(report.report_id)
  const lastConfirmed = report.last_confirmed_at
    ? new Date(report.last_confirmed_at).toLocaleString()
    : "Not confirmed yet"
  const distanceKm =
    userLocation && report.coordinates
      ? haversineKm(userLocation, report.coordinates)
      : null
  const confidenceChip = reportConfidenceColors[report.confidence]

  const refreshReports = async () => {
    const bbox = mapManager.getCurrentViewBBox() ?? undefined
    const response = await getReports(bbox)
    const locationReports = response.reports.filter((report) => !report.barrier_id)
    setNearbyReports(locationReports)
    await mapManager.setReportsData(locationReports)

    const updated = locationReports.find((item) => item.report_id === report.report_id) ?? null
    setSelectedReport(updated)

    const reportLocations: MockLocation[] = locationReports
      .filter(
        (item): item is (typeof item & { coordinates: [number, number] }) =>
          Array.isArray(item.coordinates) && item.coordinates.length === 2
      )
      .map((item) => {
        const description = item.description.length > 60
          ? `${item.description.slice(0, 57)}...`
          : item.description
        return {
          id: item.report_id,
          name: item.category || "Report",
          subtitle: `${description || "User-submitted report"} - ${item.confidence.toUpperCase()} confidence`,
          lat: item.coordinates[1],
          lng: item.coordinates[0],
          bbox: null,
          type: "report",
          displayName: item.category || "Report",
        }
      })
    setSearchResults(reportLocations)

    if (!updated) {
      toast.message("This report is no longer available")
    }
  }

  const handleFeedback = async (action: "confirm" | "renounce") => {
    if (pendingAction) return
    try {
      setPendingAction(action)
      await submitReportFeedback(report.report_id, action)
      await refreshReports()
      toast.success(action === "confirm" ? "Report confirmed" : "Report renounced")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update report")
    } finally {
      setPendingAction(null)
    }
  }

  const handleCopyLink = async () => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("report", report.report_id)
      url.searchParams.set("category", report.category || "Report")
      url.searchParams.set("description", report.description || "")
      url.searchParams.set("confidence", report.confidence)
      url.searchParams.set("reports", String(report.reports_count))
      url.searchParams.set("renouncements", String(report.renouncements))
      if (report.last_confirmed_at) {
        url.searchParams.set("last_confirmed_at", report.last_confirmed_at)
      }
      if (report.coordinates) {
        url.searchParams.set("r_lat", report.coordinates[1].toFixed(6))
        url.searchParams.set("r_lng", report.coordinates[0].toFixed(6))
      }
      await copyTextToClipboard(url.toString())
      toast.success("Report link copied")
    } catch {
      toast.error("Failed to copy report link")
    }
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={`Report ${reportIdNumber}`} />
      <div className="flex-1 overflow-y-auto panel-scroll px-4 pb-6">
        <div className="flex items-center gap-2.5 pt-4 mb-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#FF6B35]/12">
            <AlertTriangle className="h-[18px] w-[18px] text-[#FF6B35]" strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-[13px] font-medium text-[#86868B] capitalize">report</p>
            <span
              className="inline-flex h-[18px] items-center rounded-[6px] px-1.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ backgroundColor: confidenceChip.bg, color: confidenceChip.text }}
            >
              {report.confidence} confidence
            </span>
          </div>
        </div>

        <div className="mt-4 rounded-[18px] bg-white/90 p-4 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
          <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">Category</p>
          <p className="text-[15px] font-medium text-[#1D1D1F] mb-3">{report.category}</p>
          <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">Description</p>
          <p className="text-[14px] font-normal text-[#1D1D1F]">{report.description}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-3 mb-1">
          <MetricCard label="Reports" value={String(report.reports_count)} accent="#34C759" />
          <MetricCard label="Renouncements" value={String(report.renouncements)} accent="#FF3B30" />
          <MetricCard
            label="Distance"
            value={distanceKm === null ? "N/A" : `${distanceKm.toFixed(1)} km`}
            accent={distanceKm === null ? "#8E8E93" : "#007AFF"}
          />
          <MetricCard label="Report ID" value={reportIdNumber} accent="#8E8E93" />
        </div>

        <p className="text-[12px] text-[#86868B] mt-2 px-1">
          Last confirmed: {lastConfirmed}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => void handleFeedback("confirm")}
            disabled={pendingAction !== null}
            className="h-[42px] rounded-[14px] bg-[#007AFF] text-[14px] font-semibold text-white hover:bg-[#0066DD] transition-colors duration-150 disabled:opacity-70"
          >
            {pendingAction === "confirm" ? "Confirming..." : "Confirm"}
          </button>
          <button
            onClick={() => void handleFeedback("renounce")}
            disabled={pendingAction !== null}
            className="h-[42px] rounded-[14px] bg-white/90 text-[14px] font-semibold text-[#1D1D1F] shadow-[0_1px_4px_rgba(0,0,0,0.04)] hover:bg-white transition-colors duration-150 disabled:opacity-70"
          >
            {pendingAction === "renounce" ? "Renouncing..." : "Renounce"}
          </button>
        </div>

        <button
          onClick={() => void handleCopyLink()}
          className="mt-2 w-full flex items-center justify-center gap-1.5 h-[40px] rounded-[14px] bg-white/90 text-[13px] font-medium text-[#1D1D1F] shadow-[0_1px_4px_rgba(0,0,0,0.04)] hover:bg-white transition-colors duration-150"
        >
          <Link2 className="h-3.5 w-3.5" strokeWidth={1.5} />
          Copy link
        </button>
      </div>
    </div>
  )
}

function SelectedLocationCTA() {
  const { selectedLocation, setActiveMode, setBbox } = useAppState()

  if (!selectedLocation) return null

  return (
    <div className="mx-4 mt-4 rounded-xl bg-white border border-black/[0.06] p-4">
      <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">Selected</p>
      <p className="text-[15px] font-medium text-[#1D1D1F] mb-0.5">{selectedLocation.name}</p>
      <p className="text-[13px] font-normal text-[#86868B] mb-3">{selectedLocation.subtitle}</p>
      <div className="flex gap-2">
        <button
          onClick={() => {
            void mapManager.flyTo({
              bbox: selectedLocation.bbox ?? undefined,
              center: [selectedLocation.lng, selectedLocation.lat],
              zoom: 13.5,
            })
          }}
          className="flex-1 h-[38px] rounded-lg bg-[#F2F2F7] text-[13px] font-medium text-[#1D1D1F] hover:bg-[#E5E5EA] transition-colors duration-150"
        >
          Zoom to location
        </button>
        <button
          onClick={() => {
            const bbox = selectedLocation.bbox ?? [
              selectedLocation.lng - 0.05,
              selectedLocation.lat - 0.05,
              selectedLocation.lng + 0.05,
              selectedLocation.lat + 0.05,
            ]
            setBbox(bbox)
            setActiveMode("analyze")
          }}
          className="flex-1 h-[38px] rounded-lg bg-[#007AFF] text-[13px] font-semibold text-white hover:bg-[#0066DD] transition-colors duration-150"
        >
          Analyze this area
        </button>
      </div>
    </div>
  )
}
