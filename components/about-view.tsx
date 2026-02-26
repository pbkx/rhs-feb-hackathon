"use client"

import { useAppState } from "@/lib/app-context"
import { PanelHeader } from "@/components/panel-header"

function ValueRow({
  label,
  value,
  description,
}: {
  label: string
  value: string
  description: string
}) {
  return (
    <div className="rounded-[14px] bg-white/90 px-3.5 py-3 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-[#1D1D1F]">{label}</p>
        <span className="text-[12px] font-mono text-[#007AFF]">{value}</span>
      </div>
      <p className="mt-1 text-[12px] text-[#6E6E73]">{description}</p>
    </div>
  )
}

export function AboutInfo() {
  const { analysisPayload } = useAppState()
  const access = analysisPayload?.meta.accessibility

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="About" />
      <div className="flex-1 overflow-y-auto panel-scroll px-4 pb-6">
        <div className="pt-4 rounded-[20px] bg-white/90 p-4 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
          <p className="text-[15px] font-semibold text-[#1D1D1F] mb-1">AccessMaps metrics</p>
          <p className="text-[13px] text-[#6E6E73]">
            All distance values are in meters. Blockers are ranked by simulated improvement to general accessibility.
          </p>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <ValueRow
            label="Accessible unlock (m)"
            value="+unlock_m"
            description="Passable network length that becomes newly reachable if this blocker is fixed."
          />
          <ValueRow
            label="Blocked segment (m)"
            value="blocked_m"
            description="Length of the current blocked or limited segment tied to the blocker candidate."
          />
          <ValueRow
            label="Distance (m)"
            value="distance_m"
            description="Distance from your selected anchor (usually clicked POI) to the blocker."
          />
          <ValueRow
            label="Destinations unlocked"
            value="unlocked_poi_count"
            description="Count of snapped healthcare and essential POIs that become reachable after fixing the blocker."
          />
          <ValueRow
            label="Unlocked destination counts"
            value="{kind: count}"
            description="Breakdown of unlocked POIs by mapped kind, for example hospital, pharmacy, toilets, or bench."
          />
          <ValueRow
            label="NAS Delta"
            value="delta_nas_points"
            description="Change in Network Accessibility Score after simulated fix."
          />
          <ValueRow
            label="OAS Delta"
            value="delta_oas_points"
            description="Change in Opportunity Accessibility Score after simulated fix."
          />
          <ValueRow
            label="General Index Delta"
            value="delta_general_points"
            description="Combined score change used to compare blockers."
          />
          <ValueRow
            label="Confidence"
            value="low/medium/high"
            description="Derived from explicit OSM tags and boosted by nearby confirmed report signals."
          />
          <ValueRow
            label="OSM ID"
            value="way/<id> or report/<id>"
            description="Data provenance identifier for the mapped feature or report-derived candidate."
          />
        </div>

        <div className="mt-3 rounded-[20px] bg-white/90 p-4 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
          <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">
            Calculation method
          </p>
          <p className="text-[13px] text-[#1D1D1F] mb-2">
            NAS = 100 * (0.35 * coverage + 0.30 * continuity + 0.20 * quality + 0.15 * (1 - blocker pressure))
          </p>
          <p className="text-[13px] text-[#1D1D1F] mb-2">
            OAS = 100 * (reachable snapped POIs / total snapped POIs)
          </p>
          <p className="text-[13px] text-[#1D1D1F] mb-2">
            General Accessibility Index = 0.70 * NAS + 0.30 * OAS
          </p>
          <p className="text-[13px] text-[#1D1D1F]">
            Rank score = 3 * DeltaGeneral + unlock_m / 750 + confidence bonus - fix cost penalty
          </p>
        </div>

        <div className="mt-3 rounded-[20px] bg-white/90 p-4 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
          <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em] mb-2">
            Current run
          </p>
          {access ? (
            <div className="grid grid-cols-2 gap-2">
              <ValueRow
                label="NAS"
                value={access.network_accessibility_score.toFixed(1)}
                description="Network Accessibility Score for current base reachability."
              />
              <ValueRow
                label="OAS"
                value={access.opportunity_accessibility_score.toFixed(1)}
                description="Opportunity score based on snapped destinations currently reachable."
              />
              <ValueRow
                label="General Index"
                value={access.general_accessibility_index.toFixed(1)}
                description="Combined baseline score before any simulated fixes."
              />
              <ValueRow
                label="Coverage ratio"
                value={access.metrics.coverage_ratio.toFixed(3)}
                description="Share of network length classified passable."
              />
            </div>
          ) : (
            <p className="text-[13px] text-[#6E6E73]">
              Run an analysis to populate live values for this area.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
