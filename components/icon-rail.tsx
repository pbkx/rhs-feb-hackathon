"use client"

import { useAppState, type AppMode } from "@/lib/app-context"
import { mapManager } from "@/lib/map/manager"
import { Search, BarChart3, Flag } from "lucide-react"
import { useState, useRef, useEffect } from "react"
import { createPortal } from "react-dom"

const modes: { mode: AppMode; icon: typeof Search; label: string }[] = [
  { mode: "search", icon: Search, label: "Search" },
  { mode: "analyze", icon: BarChart3, label: "Analyze" },
  { mode: "report", icon: Flag, label: "Report" },
]

function Tooltip({ label, anchorEl }: { label: string; anchorEl: HTMLElement | null }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    if (!anchorEl) return
    const r = anchorEl.getBoundingClientRect()
    setPos({ top: r.top + r.height / 2, left: r.right + 10 })
  }, [anchorEl])

  if (!mounted || !pos) return null
  return createPortal(
    <div
      className="fixed pointer-events-none"
      style={{ top: pos.top, left: pos.left, transform: "translateY(-50%)", zIndex: 999999 }}
    >
      <div className="flex items-center">
        <div className="w-[6px] h-[6px] bg-[#1D1D1F]/80 rotate-45 -mr-[3px] rounded-[1px]" />
        <div className="bg-[#1D1D1F]/80 backdrop-blur-md text-white text-[12px] font-medium px-2.5 py-1 rounded-[6px] whitespace-nowrap">
          {label}
        </div>
      </div>
    </div>,
    document.body
  )
}

interface IconRailProps {
  collapsed: boolean
  onToggleCollapse: () => void
}

export function IconRail({ collapsed, onToggleCollapse }: IconRailProps) {
  const {
    activeMode,
    setActiveMode,
    panelOpen,
    resetReportDraft,
    updateReportDraft,
    setReportLocationMode,
  } = useAppState()
  const [hoveredMode, setHoveredMode] = useState<string | null>(null)
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const handleModeClick = (mode: AppMode, isActive: boolean) => {
    if (isActive) {
      setReportLocationMode(false)
      updateReportDraft({ coordinates: null })
      void mapManager.setReportPickMode(false)
      void mapManager.clearReportMarker()
      setActiveMode(null)
      return
    }
    if (activeMode === "report" && mode !== "report") {
      setReportLocationMode(false)
      updateReportDraft({ coordinates: null })
      void mapManager.setReportPickMode(false)
      void mapManager.clearReportMarker()
    }
    if (mode === "report") {
      resetReportDraft()
      updateReportDraft({
        barrierId: undefined,
        coordinates: null,
      })
      setReportLocationMode(true)
    }
    setActiveMode(mode)
  }

  return (
    <aside
      className="h-full flex-shrink-0 relative z-20"
      style={{ width: collapsed ? 52 : 180, transition: "width 200ms linear" }}
    >
      <div className="h-full flex flex-col">
        <div className="flex items-center h-[52px] flex-shrink-0" style={{ padding: collapsed ? "0 12px" : "0 14px" }}>
          {!collapsed && (
            <>
              <span className="text-[18px] font-semibold tracking-[-0.01em] text-[#1D1D1F] whitespace-nowrap leading-none flex-1">
                AccessMaps
              </span>
              <button
                onClick={onToggleCollapse}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] hover:bg-[#767680]/[0.08] transition-colors duration-150 flex-shrink-0"
                aria-label="Collapse sidebar"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="#86868B" strokeWidth="1.2" fill="none" />
                  <line x1="6" y1="1.5" x2="6" y2="14.5" stroke="#86868B" strokeWidth="1.2" />
                </svg>
              </button>
            </>
          )}
          {collapsed && (
            <button
              onClick={onToggleCollapse}
              className="flex h-[30px] w-[28px] items-center justify-center rounded-[8px] hover:bg-[#767680]/[0.08] transition-colors duration-150 mx-auto"
              aria-label="Expand sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="#86868B" strokeWidth="1.2" fill="none" />
                <line x1="6" y1="1.5" x2="6" y2="14.5" stroke="#86868B" strokeWidth="1.2" />
              </svg>
            </button>
          )}
        </div>

        <nav className="flex flex-col gap-0.5 mt-1" style={{ padding: "0 5px" }} aria-label="Navigation modes">
          {modes.map(({ mode, icon: Icon, label }) => {
            const isActive = activeMode === mode && panelOpen
            return (
              <div key={mode} className="relative">
                <button
                  ref={(el) => { btnRefs.current[mode] = el }}
                  onClick={() => handleModeClick(mode, isActive)}
                  onMouseEnter={() => { if (collapsed) setHoveredMode(mode) }}
                  onMouseLeave={() => setHoveredMode(null)}
                  className={`flex items-center rounded-[9px] transition-colors duration-150 hover:bg-[#767680]/[0.08] ${
                    collapsed ? "w-[42px] h-[42px] justify-center" : "h-[42px] w-full pr-[9px] text-left"
                  }`}
                  aria-label={label}
                  aria-pressed={isActive}
                >
                  <div className="flex h-[42px] w-[42px] items-center justify-center flex-shrink-0">
                    <div
                      className={`flex items-center justify-center rounded-[7px] h-[28px] w-[28px] ${
                        isActive ? "bg-[#007AFF]" : "bg-[#8E8E93]"
                      }`}
                    >
                      <Icon className="h-[15px] w-[15px] text-white" strokeWidth={1.8} />
                    </div>
                  </div>
                  {!collapsed && (
                    <span className="text-[15px] font-normal text-[#8E8E93] whitespace-nowrap">
                      {label}
                    </span>
                  )}
                </button>
                {collapsed && hoveredMode === mode && (
                  <Tooltip label={label} anchorEl={btnRefs.current[mode]} />
                )}
              </div>
            )
          })}
        </nav>

        <div className="flex-1" />
      </div>
    </aside>
  )
}
