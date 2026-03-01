"use client"

import { useEffect, useState } from "react"
import { useAppState } from "@/lib/app-context"
import { getBootstrap, getReports, submitReport } from "@/lib/api/client"
import { candidatesFromAnalyzeResult } from "@/lib/barrier-candidate"
import { PanelHeader } from "@/components/panel-header"
import { mapManager } from "@/lib/map/manager"
import { MapPin, CheckCircle2, ChevronDown } from "lucide-react"
import { toast } from "sonner"

const defaultCategories = [
  "Blocked sidewalk",
  "Broken curb ramp",
  "No curb ramp",
  "Elevator out of service",
  "Construction detour",
  "Flooded path",
  "Unsafe crossing",
  "Accessibility issue",
  "Other",
]
const barrierCategories = ["Incorrect blocker", "Accessibility issue", "Other"]

export function ReportForm() {
  const {
    selectedBarrier,
    setSelectedBarrier,
    reportDraft,
    updateReportDraft,
    reportLocationMode,
    setReportLocationMode,
    pushView,
    resetReportDraft,
    analysisPayload,
    setAnalysisPayload,
    setCandidates,
  } = useAppState()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isBarrierReport = Boolean(reportDraft.barrierId)
  const barrierName =
    isBarrierReport && selectedBarrier && selectedBarrier.id === reportDraft.barrierId
      ? selectedBarrier.name
      : "Selected barrier"
  const categories = isBarrierReport ? barrierCategories : defaultCategories

  useEffect(() => {
    if (!reportDraft.category) return
    if (categories.includes(reportDraft.category)) return
    updateReportDraft({ category: "" })
  }, [categories, reportDraft.category, updateReportDraft])

  const handleSubmit = async () => {
    if (!reportDraft.category || !reportDraft.description.trim()) {
      toast.error("Please fill in all required fields")
      return
    }
    if (!isBarrierReport && !reportDraft.coordinates) {
      toast.error("Select a location on the map before submitting", { position: "bottom-center" })
      return
    }
    if (isSubmitting) return

    try {
      setIsSubmitting(true)
      const includeCoordinates = !isBarrierReport
      const submittedBarrierId = reportDraft.barrierId ?? null
      const blockedStepsRaw = reportDraft.blockedSteps.trim()
      const blockedSteps =
        blockedStepsRaw.length > 0 && Number.isFinite(Number(blockedStepsRaw))
          ? Math.max(0, Math.round(Number(blockedStepsRaw)))
          : undefined
      await submitReport({
        barrier_id: reportDraft.barrierId,
        category: reportDraft.category,
        description: reportDraft.description.trim(),
        email: reportDraft.email.trim() || undefined,
        blocked_steps: includeCoordinates ? blockedSteps : undefined,
        include_coordinates: includeCoordinates,
        coordinates: includeCoordinates ? reportDraft.coordinates : null,
      })

      if (submittedBarrierId && analysisPayload) {
        void (async () => {
          try {
            const reportsResponse = await getReports()
            const refreshedCandidates = candidatesFromAnalyzeResult(
              analysisPayload,
              reportsResponse.reports
            )
            setCandidates(refreshedCandidates)
            const updatedSelected =
              refreshedCandidates.find((candidate) => candidate.id === submittedBarrierId) ?? null
            if (updatedSelected) {
              setSelectedBarrier(updatedSelected)
            }
          } catch (error) {
            console.warn("[report] failed to refresh barrier confidence", error)
          }
        })()
      } else if (submittedBarrierId) {
        void (async () => {
          try {
            const bootstrap = await getBootstrap()
            setAnalysisPayload(bootstrap.analysis_payload)
            const refreshedCandidates = candidatesFromAnalyzeResult(
              bootstrap.analysis_payload,
              bootstrap.reports
            )
            setCandidates(refreshedCandidates)
            const updatedSelected =
              refreshedCandidates.find((candidate) => candidate.id === submittedBarrierId) ?? null
            if (updatedSelected) {
              setSelectedBarrier(updatedSelected)
            }
          } catch (error) {
            console.warn("[report] failed bootstrap confidence refresh", error)
          }
        })()
      }

      toast.success("Report submitted successfully")
      setReportLocationMode(false)
      resetReportDraft()
      pushView("ReportSuccess")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to submit report")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLocationButton = () => {
    if (reportLocationMode || reportDraft.coordinates) {
      setReportLocationMode(false)
      if (reportDraft.coordinates) {
        updateReportDraft({ coordinates: null })
      }
      void mapManager.setReportPickMode(false)
      void mapManager.clearReportMarker()
      return
    }
    setReportLocationMode(true)
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="Report" />
      <div className="flex-1 overflow-y-auto panel-scroll px-4 pb-6">
        {isBarrierReport && (
          <div className="mt-4 mb-4 flex items-center gap-3 rounded-[18px] bg-white/90 px-4 py-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#FF6B35]/10 flex-shrink-0">
              <MapPin className="h-[14px] w-[14px] text-[#FF6B35]" strokeWidth={1.5} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] text-[#86868B] font-medium">Reporting</p>
              <p className="text-[14px] text-[#1D1D1F] font-medium truncate">{barrierName}</p>
            </div>
          </div>
        )}

        {!isBarrierReport && (
          <div className="mt-4 mb-4">
            <p className="text-[15px] text-[#1D1D1F] font-medium mb-2 px-1">Report a location</p>
            <button
              onClick={handleLocationButton}
              className={`flex items-center justify-center gap-1.5 w-full h-[40px] rounded-[14px] text-[13px] font-medium transition-colors duration-150 ${
                reportLocationMode
                  ? "bg-[#007AFF] text-white"
                  : "bg-white/90 text-[#1D1D1F] shadow-[0_1px_4px_rgba(0,0,0,0.04)] hover:bg-white"
              }`}
            >
              <MapPin className="h-3.5 w-3.5" strokeWidth={1.5} />
              {reportLocationMode
                ? "Selecting location..."
                : reportDraft.coordinates
                ? "Clear picked location"
                : "Pick on map"}
            </button>
          </div>
        )}

        <div className="flex flex-col gap-4">
          <div>
            <label className="text-[13px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2.5 block px-1">
              Category
            </label>
            <div className="relative">
              <select
                value={reportDraft.category}
                onChange={(e) => updateReportDraft({ category: e.target.value })}
                className="appearance-none w-full h-[44px] rounded-[16px] bg-white/90 px-4 pr-10 text-[15px] font-normal text-[#1D1D1F] shadow-[0_1px_4px_rgba(0,0,0,0.04)] outline-none focus:shadow-[0_0_0_2px_#007AFF] transition-shadow cursor-pointer"
              >
                <option value="">Select category...</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#C7C7CC]" strokeWidth={2} />
            </div>
          </div>

          <div>
            <label className="text-[13px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2.5 block px-1">
              Description
            </label>
            <textarea
              value={reportDraft.description}
              onChange={(e) => updateReportDraft({ description: e.target.value })}
              placeholder="Describe the issue..."
              rows={4}
              className="w-full rounded-[16px] bg-white/90 px-4 py-3 text-[15px] font-normal text-[#1D1D1F] placeholder:text-[#C7C7CC] shadow-[0_1px_4px_rgba(0,0,0,0.04)] outline-none focus:shadow-[0_0_0_2px_#007AFF] transition-shadow resize-none"
            />
          </div>

          {!isBarrierReport && (
            <div>
              <label className="text-[13px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2.5 block px-1">
                Blocked Steps (optional)
              </label>
              <input
                type="number"
                min={0}
                step={1}
                value={reportDraft.blockedSteps}
                onChange={(e) => updateReportDraft({ blockedSteps: e.target.value })}
                placeholder="e.g. 5"
                className="w-full h-[44px] rounded-[16px] bg-white/90 px-4 text-[15px] font-normal text-[#1D1D1F] placeholder:text-[#C7C7CC] shadow-[0_1px_4px_rgba(0,0,0,0.04)] outline-none focus:shadow-[0_0_0_2px_#007AFF] transition-shadow"
              />
            </div>
          )}

          <div>
            <label className="text-[13px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2.5 block px-1">
              Email (optional)
            </label>
            <input
              type="email"
              value={reportDraft.email}
              onChange={(e) => updateReportDraft({ email: e.target.value })}
              placeholder="your@email.com"
              className="w-full h-[44px] rounded-[16px] bg-white/90 px-4 text-[15px] font-normal text-[#1D1D1F] placeholder:text-[#C7C7CC] shadow-[0_1px_4px_rgba(0,0,0,0.04)] outline-none focus:shadow-[0_0_0_2px_#007AFF] transition-shadow"
            />
          </div>

          <button
            onClick={() => void handleSubmit()}
            disabled={isSubmitting}
            className="w-full h-[48px] rounded-[16px] bg-[#007AFF] text-[15px] font-semibold text-white hover:bg-[#0066DD] shadow-[0_4px_14px_rgba(0,122,255,0.2)] transition-colors duration-150 disabled:opacity-70"
          >
            {isSubmitting ? "Submitting..." : "Submit Report"}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ReportSuccess() {
  const { closePanel, resetNav, resetReportDraft, setReportLocationMode } = useAppState()

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="Report Submitted" />
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-12">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#34C759]/12 mb-4">
          <CheckCircle2 className="h-8 w-8 text-[#34C759]" strokeWidth={1.4} />
        </div>
        <h3 className="text-[20px] font-semibold tracking-tight text-[#1D1D1F] mb-1 text-center text-balance">Thank you!</h3>
        <p className="text-[14px] font-normal text-[#86868B] text-center mb-8 max-w-[260px] text-pretty">
          Your report has been submitted and will be reviewed by our team.
        </p>
        <div className="flex flex-col gap-2.5 w-full max-w-[240px]">
          <button
            onClick={closePanel}
            className="w-full h-[44px] rounded-[14px] bg-[#007AFF] text-[14px] font-semibold text-white hover:bg-[#0066DD] transition-colors duration-150"
          >
            Back to map
          </button>
          <button
            onClick={() => {
              resetReportDraft()
              setReportLocationMode(false)
              resetNav("ReportForm")
            }}
            className="w-full h-[44px] rounded-[14px] bg-white/90 text-[14px] font-medium text-[#1D1D1F] shadow-[0_1px_4px_rgba(0,0,0,0.04)] hover:bg-white transition-colors duration-150"
          >
            Create another report
          </button>
        </div>
      </div>
    </div>
  )
}
