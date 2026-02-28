"use client"

import type { ReactNode } from "react"
import { useAppState } from "@/lib/app-context"
import { PanelHeader } from "@/components/panel-header"

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <section className="mt-3 rounded-[20px] bg-white/90 p-4 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
      <p className="text-[12px] font-semibold text-[#86868B] uppercase tracking-[0.06em]">{title}</p>
      {subtitle ? <p className="mt-1 text-[13px] text-[#6E6E73]">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function DefinitionRow({
  name,
  value,
  description,
}: {
  name: string
  value: string
  description: string
}) {
  return (
    <div className="rounded-[14px] bg-white px-3.5 py-3 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-[#1D1D1F]">{name}</p>
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
          <p className="text-[15px] font-semibold text-[#1D1D1F] mb-1">AccessMaps scoring guide</p>
          <p className="text-[13px] text-[#6E6E73]">
            Distances are shown in meters below 1 km, then in kilometers. Scores estimate how reachable and usable
            the pedestrian network is for mobility access.
          </p>
        </div>

        <Section
          title="Core Scores"
          subtitle="These are the three main values used in analysis and blocker ranking."
        >
          <div className="flex flex-col gap-2">
            <DefinitionRow
              name="NAS (Network Accessibility Score)"
              value="0-100"
              description="How traversable the network is, based on coverage, continuity, quality, and blocker pressure."
            />
            <DefinitionRow
              name="OAS (Opportunity Accessibility Score)"
              value="0-100"
              description="How many snapped destinations are reachable from the anchor point."
            />
            <DefinitionRow
              name="General Accessibility Index"
              value="0-100"
              description="Final baseline score used for comparison: 70% NAS + 30% OAS."
            />
          </div>
        </Section>

        <Section title="Calculation Formulae">
          <div className="flex flex-col gap-2 text-[13px] text-[#1D1D1F]">
            <p>NAS = 100 * (0.35 * coverage + 0.30 * continuity + 0.20 * quality + 0.15 * (1 - blocker pressure))</p>
            <p>OAS = 100 * (reachable snapped POIs / total snapped POIs)</p>
            <p>General Accessibility Index = 0.70 * NAS + 0.30 * OAS</p>
            <p>Rank score = 3 * DeltaGeneral + unlock_m / 750 + confidence bonus - fix cost penalty</p>
          </div>
        </Section>

        <Section title="Output Fields">
          <div className="flex flex-col gap-2">
            <DefinitionRow
              name="Accessible unlock"
              value="+unlock_m"
              description="Newly reachable passable path length after a simulated fix."
            />
            <DefinitionRow
              name="Blocked segment"
              value="blocked_m"
              description="Length of the segment currently acting as the blocker."
            />
            <DefinitionRow
              name="Distance"
              value="distance_m"
              description="Distance from your selected anchor to the candidate blocker."
            />
            <DefinitionRow
              name="Destinations unlocked"
              value="unlocked_poi_count"
              description="Count of healthcare and essential POIs that become reachable."
            />
            <DefinitionRow
              name="Confidence"
              value="low / medium / high"
              description="Derived from OSM evidence and community report reinforcement."
            />
            <DefinitionRow
              name="OSM ID"
              value="way/<id> or N/A"
              description="Source ID for mapped blockers. Synthetic location-report blockers use N/A."
            />
          </div>
        </Section>

        <Section
          title="Current Run"
          subtitle="Live values from the most recent analysis for the current area."
        >
          {access ? (
            <div className="grid grid-cols-2 gap-2">
              <DefinitionRow
                name="NAS"
                value={access.network_accessibility_score.toFixed(1)}
                description="Network Accessibility Score for the current baseline."
              />
              <DefinitionRow
                name="OAS"
                value={access.opportunity_accessibility_score.toFixed(1)}
                description="Opportunity Accessibility Score for currently reachable destinations."
              />
              <DefinitionRow
                name="General Index"
                value={access.general_accessibility_index.toFixed(1)}
                description="Combined accessibility score before simulated fixes."
              />
              <DefinitionRow
                name="Coverage ratio"
                value={access.metrics.coverage_ratio.toFixed(3)}
                description="Share of network length currently classified as passable."
              />
            </div>
          ) : (
            <p className="text-[13px] text-[#6E6E73]">Run an analysis to populate live values for this area.</p>
          )}
        </Section>
      </div>
    </div>
  )
}
