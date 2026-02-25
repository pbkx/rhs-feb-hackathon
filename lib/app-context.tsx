"use client"

import { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import type { AnalyzeResultPayload, ReportRecord } from "@/lib/api/client"

export type AppMode = "search" | "analyze" | "report"
type AnalysisStatus = "idle" | "loading" | "done" | "error"
export type BBox = [number, number, number, number]

export interface MockLocation {
  id: string
  name: string
  subtitle: string
  lat: number
  lng: number
  bbox: BBox | null
  type: string
  displayName: string
}

export interface MockBarrier {
  id: string
  name: string
  type:
    | "stairs"
    | "raised_kerb"
    | "steep_incline"
    | "rough_surface"
    | "wheelchair_no"
    | "wheelchair_limited"
    | "access_no"
    | "report"
    | "other"
    | "dam"
    | "weir"
    | "waterfall"
  gain: number
  upstreamBlocked: number
  confidence: "high" | "medium" | "low"
  distance: number
  deltaNas: number
  deltaOas: number
  deltaGeneral: number
  baselineIndex: number
  postFixIndex: number
  unlockedPoiCount: number
  unlockedDestinationCounts: Record<string, number>
  unlockedComponentId: number | null
  score: number
  osmId: string
  tags: Record<string, string>
  inferredSignals: string[]
  reason?: string
  locationLabel?: string
  calculationMethod?: string
  lat: number
  lng: number
}

interface ReportDraft {
  barrierId?: string
  category: string
  description: string
  email: string
  coordinates: [number, number] | null
}

interface AppState {
  activeMode: AppMode | null
  panelOpen: boolean
  navStack: string[]
  selectedLocation: MockLocation | null
  searchResults: MockLocation[]
  searchQuery: string
  bboxSelected: BBox | null
  analysisStatus: AnalysisStatus
  analysisJobId: string | null
  analysisPayload: AnalyzeResultPayload | null
  analysisAnchor: [number, number] | null
  analysisAnchorPoiId: string | null
  currentStep: number
  candidates: MockBarrier[]
  selectedBarrier: MockBarrier | null
  selectedReport: ReportRecord | null
  nearbyReports: ReportRecord[]
  reportDraft: ReportDraft
  reportLocationMode: boolean
  recentSearches: { query: string; subtitle: string }[]
  userLocation: [number, number] | null
  radius: string
  sortBy: string
  filterTypes: string[]
  filterConfidence: string[]
}

interface AppContextValue extends AppState {
  setActiveMode: (mode: AppMode | null) => void
  closePanel: () => void
  pushView: (view: string) => void
  popView: () => void
  resetNav: (root: string) => void
  setSelectedLocation: (loc: MockLocation | null) => void
  setSearchResults: (results: MockLocation[]) => void
  setSearchQuery: (query: string) => void
  setBbox: (bbox: BBox | null) => void
  setAnalysisStatus: (status: AnalysisStatus) => void
  setAnalysisJobId: (id: string | null) => void
  setAnalysisPayload: (payload: AnalyzeResultPayload | null) => void
  setAnalysisAnchor: (anchor: [number, number] | null) => void
  setAnalysisAnchorPoiId: (poiId: string | null) => void
  setCurrentStep: (step: number) => void
  setCandidates: (c: MockBarrier[]) => void
  setSelectedBarrier: (b: MockBarrier | null) => void
  setSelectedReport: (report: ReportRecord | null) => void
  setNearbyReports: (reports: ReportRecord[]) => void
  updateReportDraft: (partial: Partial<ReportDraft>) => void
  resetReportDraft: () => void
  setReportLocationMode: (v: boolean) => void
  addRecentSearch: (query: string, subtitle: string) => void
  setUserLocation: (coords: [number, number] | null) => void
  setRadius: (v: string) => void
  setSortBy: (v: string) => void
  setFilterTypes: (v: string[]) => void
  setFilterConfidence: (v: string[]) => void
  currentView: string
}

const AppContext = createContext<AppContextValue | null>(null)

export function useAppState() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error("useAppState must be used within AppProvider")
  return ctx
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeMode, setActiveModeRaw] = useState<AppMode | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [navStack, setNavStack] = useState<string[]>([])
  const [selectedLocation, setSelectedLocation] = useState<MockLocation | null>(null)
  const [searchResults, setSearchResults] = useState<MockLocation[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [bboxSelected, setBbox] = useState<BBox | null>(null)
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>("idle")
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null)
  const [analysisPayload, setAnalysisPayload] = useState<AnalyzeResultPayload | null>(null)
  const [analysisAnchor, setAnalysisAnchor] = useState<[number, number] | null>(null)
  const [analysisAnchorPoiId, setAnalysisAnchorPoiId] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [candidates, setCandidates] = useState<MockBarrier[]>([])
  const [selectedBarrier, setSelectedBarrier] = useState<MockBarrier | null>(null)
  const [selectedReport, setSelectedReport] = useState<ReportRecord | null>(null)
  const [nearbyReports, setNearbyReports] = useState<ReportRecord[]>([])
  const [reportDraft, setReportDraft] = useState<ReportDraft>({
    category: "",
    description: "",
    email: "",
    coordinates: null,
  })
  const [reportLocationMode, setReportLocationMode] = useState(false)
  const [recentSearches, setRecentSearches] = useState<{ query: string; subtitle: string }[]>([])
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null)
  const [radius, setRadius] = useState("viewport")
  const [sortBy, setSortBy] = useState("impact")
  const [filterTypes, setFilterTypes] = useState<string[]>([])
  const [filterConfidence, setFilterConfidence] = useState<string[]>([])

  const setActiveMode = useCallback((mode: AppMode | null) => {
    if (mode === null) {
      setActiveModeRaw(null)
      setPanelOpen(false)
      setNavStack([])
      setReportLocationMode(false)
      setReportDraft((prev) => ({ ...prev, coordinates: null }))
    } else {
      setActiveModeRaw(mode)
      setPanelOpen(true)
      const rootViews: Record<AppMode, string> = {
        search: "SearchHome",
        analyze: "AnalyzeSetup",
        report: "ReportForm",
      }
      setNavStack([rootViews[mode]])
    }
  }, [])

  const closePanel = useCallback(() => {
    setPanelOpen(false)
    setActiveModeRaw(null)
    setNavStack([])
    setReportLocationMode(false)
    setReportDraft((prev) => ({ ...prev, coordinates: null }))
  }, [])

  const pushView = useCallback((view: string) => {
    setNavStack((prev) => [...prev, view])
  }, [])

  const popView = useCallback(() => {
    setNavStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }, [])

  const resetNav = useCallback((root: string) => {
    setNavStack([root])
  }, [])

  const updateReportDraft = useCallback((partial: Partial<ReportDraft>) => {
    setReportDraft((prev) => ({ ...prev, ...partial }))
  }, [])

  const resetReportDraft = useCallback(() => {
    setReportDraft({
      barrierId: undefined,
      category: "",
      description: "",
      email: "",
      coordinates: null,
    })
  }, [])

  const addRecentSearch = useCallback((query: string, subtitle: string) => {
    setRecentSearches((prev) => {
      const filtered = prev.filter((s) => s.query !== query)
      return [{ query, subtitle }, ...filtered].slice(0, 3)
    })
  }, [])

  const currentView = navStack[navStack.length - 1] || ""

  return (
    <AppContext.Provider
      value={{
        activeMode,
        panelOpen,
        navStack,
        selectedLocation,
        searchResults,
        searchQuery,
        bboxSelected,
        analysisStatus,
        analysisJobId,
        analysisPayload,
        analysisAnchor,
        analysisAnchorPoiId,
        currentStep,
        candidates,
        selectedBarrier,
        selectedReport,
        nearbyReports,
        reportDraft,
        reportLocationMode,
        recentSearches,
        userLocation,
        radius,
        sortBy,
        filterTypes,
        filterConfidence,
        setActiveMode,
        closePanel,
        pushView,
        popView,
        resetNav,
        setSelectedLocation,
        setSearchResults,
        setSearchQuery,
        setBbox,
        setAnalysisStatus,
        setAnalysisJobId,
        setAnalysisPayload,
        setAnalysisAnchor,
        setAnalysisAnchorPoiId,
        setCurrentStep,
        setCandidates,
        setSelectedBarrier,
        setSelectedReport,
        setNearbyReports,
        updateReportDraft,
        resetReportDraft,
        setReportLocationMode,
        addRecentSearch,
        setUserLocation,
        setRadius,
        setSortBy,
        setFilterTypes,
        setFilterConfidence,
        currentView,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}
