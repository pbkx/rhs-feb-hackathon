"use client"

import { useAppState } from "@/lib/app-context"
import { mapManager } from "@/lib/map/manager"
import { ChevronLeft, X } from "lucide-react"

interface PanelHeaderProps {
  title: string
}

export function PanelHeader({ title }: PanelHeaderProps) {
  const { navStack, popView, closePanel, setReportLocationMode, updateReportDraft } = useAppState()
  const canGoBack = navStack.length > 1

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-[52px]">
      {canGoBack && (
        <button
          onClick={popView}
          className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[#767680]/[0.08] transition-colors duration-150 -ml-1 flex-shrink-0"
          aria-label="Go back"
        >
          <ChevronLeft className="h-[18px] w-[18px] text-[#007AFF]" strokeWidth={2.2} />
        </button>
      )}
      <h2 className="flex-1 text-[22px] font-bold tracking-tight text-[#1D1D1F] truncate leading-none">
        {title}
      </h2>
      <button
        onClick={() => {
          setReportLocationMode(false)
          updateReportDraft({ coordinates: null })
          void mapManager.setReportPickMode(false)
          void mapManager.clearReportMarker()
          closePanel()
        }}
        className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-[#E8E8ED]/80 hover:bg-[#DCDCE0] transition-colors duration-150 flex-shrink-0"
        aria-label="Close panel"
      >
        <X className="h-[11px] w-[11px] text-[#86868B]" strokeWidth={3} />
      </button>
    </div>
  )
}
