import type { AnalyzeResultPayload, ReportRecord } from "@/lib/api/client"
import type { MockBarrier } from "@/lib/app-context"
import { haversineKm } from "@/lib/haversine"

const EXPLICIT_OSM_SIGNAL = "Explicitly tagged in OpenStreetMap."

function toFiniteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeBarrierType(value: unknown): MockBarrier["type"] {
  const type = typeof value === "string" ? value.toLowerCase() : ""
  if (type === "stairs") return "stairs"
  if (type === "raised_kerb" || type === "kerb") return "raised_kerb"
  if (type === "steep_incline") return "steep_incline"
  if (type === "rough_surface") return "rough_surface"
  if (type === "wheelchair_no") return "wheelchair_no"
  if (type === "wheelchair_limited") return "wheelchair_limited"
  if (type === "access_no") return "access_no"
  if (type === "report") return "report"
  if (type === "weir") return "weir"
  if (type === "waterfall") return "waterfall"
  if (type === "dam") return "dam"
  return "other"
}

function normalizeConfidence(value: unknown): MockBarrier["confidence"] {
  if (value === "high" || value === "medium" || value === "low") return value
  return "medium"
}

function normalizeSignal(value: string) {
  const trimmed = value.trim()
  const normalized = trimmed.toLowerCase().replace(/[.\s]+$/g, "")
  if (normalized.startsWith("calculation method:")) {
    return ""
  }
  if (
    normalized === "explicitly tagged in openstreetmap" ||
    normalized === "derived from mapped barrier features"
  ) {
    return EXPLICIT_OSM_SIGNAL
  }
  if (
    normalized === "marked as incorrect" ||
    normalized === "reported issue (other)" ||
    normalized === "reported"
  ) {
    return ""
  }
  return trimmed
}

function normalizeInferredSignals(signals: string[] | undefined): string[] {
  const unique = new Set<string>()
  for (const signal of signals ?? []) {
    if (typeof signal !== "string") continue
    const normalized = normalizeSignal(signal)
    if (!normalized) continue
    unique.add(normalized)
  }
  if (!unique.has(EXPLICIT_OSM_SIGNAL)) {
    unique.add(EXPLICIT_OSM_SIGNAL)
  }
  return [...unique]
}

function normalizeCandidateSignals(candidate: MockBarrier): MockBarrier {
  return {
    ...candidate,
    inferredSignals: normalizeInferredSignals(candidate.inferredSignals),
  }
}

function bboxCenter(bbox: [number, number, number, number]): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
}

function rankingToCandidate(
  ranking: AnalyzeResultPayload["rankings"][number],
  calculationMethod: string
): MockBarrier {
  const unlockMeters = toFiniteNumber(ranking.unlock_m, toFiniteNumber((ranking as any).gain_km, 0) * 1000)
  const blockedMeters = toFiniteNumber(ranking.blocked_m, toFiniteNumber((ranking as any).blocked_km, 0) * 1000)
  const distanceMeters = toFiniteNumber(ranking.distance_m, toFiniteNumber((ranking as any).distance_km, 0) * 1000)

  return {
    id: ranking.barrier_id,
    name: ranking.name,
    type: normalizeBarrierType((ranking as { type?: string; blocker_type?: string }).type ?? ranking.blocker_type),
    gain: Number(unlockMeters.toFixed(0)),
    upstreamBlocked: Number(blockedMeters.toFixed(0)),
    confidence: ranking.confidence,
    distance: Number(distanceMeters.toFixed(0)),
    deltaNas: Number(toFiniteNumber(ranking.delta_nas_points).toFixed(2)),
    deltaOas: Number(toFiniteNumber(ranking.delta_oas_points).toFixed(2)),
    deltaGeneral: Number(toFiniteNumber(ranking.delta_general_points).toFixed(2)),
    baselineIndex: Number(toFiniteNumber(ranking.baseline_general_index).toFixed(2)),
    postFixIndex: Number(toFiniteNumber(ranking.post_fix_general_index).toFixed(2)),
    unlockedPoiCount: Number(toFiniteNumber(ranking.unlocked_poi_count)),
    unlockedDestinationCounts: { ...(ranking.unlocked_destination_counts ?? {}) },
    unlockedComponentId:
      typeof ranking.unlocked_component_id === "number" && Number.isFinite(ranking.unlocked_component_id)
        ? ranking.unlocked_component_id
        : null,
    score: Number(toFiniteNumber(ranking.score).toFixed(3)),
    osmId: ranking.osm_id,
    reportCount:
      typeof ranking.reports_count === "number" && Number.isFinite(ranking.reports_count)
        ? Math.max(0, Math.round(ranking.reports_count))
        : undefined,
    renouncements:
      typeof ranking.renouncements === "number" && Number.isFinite(ranking.renouncements)
        ? Math.max(0, Math.round(ranking.renouncements))
        : undefined,
    tags: ranking.tags,
    inferredSignals: normalizeInferredSignals(ranking.inferred_signals),
    reason: ranking.reason,
    locationLabel: ranking.location_label,
    calculationMethod,
    lat: ranking.lat,
    lng: ranking.lon,
  }
}

export function applyReportConfidenceSignals(
  candidates: MockBarrier[],
  reports: ReportRecord[]
): MockBarrier[] {
  const evidenceByBarrier = new Map<string, { support: number; incorrect: number }>()

  for (const report of reports) {
    if (!report.barrier_id || report.effective_reports <= 0) continue
    const key = report.barrier_id.trim()
    if (!key) continue
    const effective = Math.max(0, Math.round(Number(report.effective_reports) || 0))
    if (effective <= 0) continue
    const category = String(report.category ?? "").trim().toLowerCase()
    const isIncorrectCategory =
      category === "incorrect blocker" ||
      category === "incorrect barrier" ||
      category.startsWith("incorrect")
    const current = evidenceByBarrier.get(key) ?? { support: 0, incorrect: 0 }
    if (isIncorrectCategory) {
      current.incorrect += effective
    } else {
      current.support += effective
    }
    evidenceByBarrier.set(key, current)
  }

  return candidates.map((candidate) => {
    const base = normalizeCandidateSignals(candidate)
    const evidence = evidenceByBarrier.get(candidate.id) ?? { support: 0, incorrect: 0 }
    const supportReports = evidence.support
    const incorrectReports = evidence.incorrect
    const inferredSignals = base.inferredSignals.filter(
      (signal) =>
        signal !== "Reported" &&
        !/^Reported by \(?\d+\)? users\.?$/i.test(signal.trim()) &&
        !/^Marked incorrect by \(?\d+\)? users\.?$/i.test(signal.trim())
    )
    if (supportReports <= 0 && incorrectReports <= 0) {
      return {
        ...base,
        inferredSignals,
      }
    }

    const confidenceRank: Record<MockBarrier["confidence"], number> = {
      low: 0,
      medium: 1,
      high: 2,
    }
    const rankToConfidence: Record<number, MockBarrier["confidence"]> = {
      0: "low",
      1: "medium",
      2: "high",
    }

    let rank = confidenceRank[base.confidence]
    const netReports = supportReports - incorrectReports
    if (netReports >= 2) {
      rank = 2
    } else if (netReports === 1 && rank < 1) {
      rank = 1
    } else if (netReports === -1) {
      rank = Math.max(0, rank - 1)
    } else if (netReports <= -2) {
      rank = 0
    }
    const confidence = rankToConfidence[rank]

    if (supportReports > 0) {
      inferredSignals.push(`Reported by ${supportReports} users.`)
    }
    if (incorrectReports > 0) {
      inferredSignals.push(`Marked incorrect by ${incorrectReports} users.`)
    }

    return {
      ...base,
      confidence,
      inferredSignals,
    }
  })
}

export function candidatesFromAnalyzeResult(
  result: AnalyzeResultPayload,
  reports: ReportRecord[] = []
): MockBarrier[] {
  const center = bboxCenter(result.meta.bbox)
  const calculationMethod = result.meta.calculation_method
  const byId = new Map<string, MockBarrier>()

  for (const ranking of result.rankings) {
    byId.set(ranking.barrier_id, rankingToCandidate(ranking, calculationMethod))
  }

  for (const feature of result.barriers_geojson.features) {
    if (feature.geometry?.type !== "Point") continue
    const coordinates = feature.geometry.coordinates
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue

    const props = (feature.properties ?? {}) as Record<string, unknown>
    const barrierIdRaw = props.barrier_id
    if (typeof barrierIdRaw !== "string" || barrierIdRaw.trim().length === 0) continue
    const barrierId = barrierIdRaw.trim()
    const current = byId.get(barrierId)

    if (current) {
      byId.set(barrierId, {
        ...current,
        lat: coordinates[1],
        lng: coordinates[0],
      })
      continue
    }

    const gainMeters = toFiniteNumber(props.unlock_m, toFiniteNumber(props.gain_km, 0) * 1000)
    const blockedMeters = toFiniteNumber(props.blocked_m, toFiniteNumber(props.blocked_km, 0) * 1000)
    const distanceMeters = haversineKm(center, [coordinates[0], coordinates[1]]) * 1000

    byId.set(barrierId, {
      id: barrierId,
      name:
        typeof props.name === "string" && props.name.trim().length > 0
          ? props.name
          : `Blocker ${byId.size + 1}`,
      type: normalizeBarrierType(props.type),
      gain: Number(gainMeters.toFixed(0)),
      upstreamBlocked: Number(blockedMeters.toFixed(0)),
      confidence: normalizeConfidence(props.confidence),
      distance: Number(distanceMeters.toFixed(0)),
      deltaNas: Number(toFiniteNumber(props.delta_nas_points).toFixed(2)),
      deltaOas: Number(toFiniteNumber(props.delta_oas_points).toFixed(2)),
      deltaGeneral: Number(toFiniteNumber(props.delta_general_points).toFixed(2)),
      baselineIndex: Number(toFiniteNumber(props.baseline_general_index).toFixed(2)),
      postFixIndex: Number(toFiniteNumber(props.post_fix_general_index).toFixed(2)),
      unlockedPoiCount: Number(toFiniteNumber(props.unlocked_poi_count)),
      unlockedDestinationCounts: {},
      unlockedComponentId: null,
      score: Number(toFiniteNumber(props.score).toFixed(3)),
      osmId: typeof props.osm_id === "string" ? props.osm_id : barrierId,
      reportCount: undefined,
      renouncements: undefined,
      tags: {},
      inferredSignals: [EXPLICIT_OSM_SIGNAL],
      calculationMethod,
      lat: coordinates[1],
      lng: coordinates[0],
    })
  }

  return applyReportConfidenceSignals(Array.from(byId.values()), reports)
}
