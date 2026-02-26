"use client"

import { useState } from "react"
import { useAppState } from "@/lib/app-context"
import { IconRail } from "@/components/icon-rail"
import { MapContainer } from "@/components/map-container"
import { SearchHome, SearchResults, ReportDetails } from "@/components/search-views"
import { AnalyzeSetup, AnalyzeLoading, AnalyzeResults, BarrierDetails } from "@/components/analyze-views"
import { ReportForm, ReportSuccess } from "@/components/report-views"
import { AboutInfo } from "@/components/about-view"

const viewComponents: Record<string, React.ComponentType> = {
  SearchHome,
  SearchResults,
  ReportDetails,
  AnalyzeSetup,
  AnalyzeLoading,
  AnalyzeResults,
  BarrierDetails,
  ReportForm,
  ReportSuccess,
  AboutInfo,
}

export function AppShell() {
  const { panelOpen, currentView } = useAppState()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const ViewComponent = currentView ? viewComponents[currentView] : null

  const sidebarW = sidebarCollapsed ? 52 : 180
  const panelW = 380

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#EEF0E8]">
      <div className="absolute inset-0 z-0">
        <MapContainer />
      </div>

      <div className="relative z-10 flex h-full w-fit flex-shrink-0">
        <div
          className="absolute inset-y-0 left-0 pointer-events-none transition-[width] duration-200 linear"
          style={{
            width: sidebarW,
            backgroundColor: "rgba(255, 255, 255, 0.85)",
            backdropFilter: "blur(34px)",
            WebkitBackdropFilter: "blur(34px)",
            borderRight: "1px solid rgba(0,0,0,0.06)",
          }}
        />

        <div
          className="absolute inset-y-0 pointer-events-none transition-[left,width,opacity] duration-200 linear"
          style={{
            left: sidebarW,
            width: panelOpen ? panelW : 0,
            opacity: panelOpen ? 1 : 0,
            backgroundColor: "rgba(255, 255, 255, 0.50)",
            backdropFilter: "blur(44px)",
            WebkitBackdropFilter: "blur(44px)",
            borderRight: panelOpen ? "1px solid rgba(0,0,0,0.06)" : "none",
          }}
        />
        <div className="relative z-10">
          <IconRail collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)} />
        </div>

        <div
          className="relative z-10 h-full overflow-hidden"
          style={{
            width: panelOpen ? panelW : 0,
            transition: "width 200ms linear",
          }}
        >
          <div
            className="h-full"
            style={{
              width: panelW,
              transform: panelOpen ? "translateX(0)" : "translateX(-100%)",
              transition: "transform 200ms linear",
            }}
          >
            {ViewComponent && (
              <div className="h-full">
                <ViewComponent />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
