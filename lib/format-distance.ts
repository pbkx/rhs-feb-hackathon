export function formatDistanceMeters(
  value: number | null | undefined,
  options?: { naLabel?: string }
) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return options?.naLabel ?? "N/A"
  }

  const meters = Math.max(0, value)
  if (meters < 1000) {
    return `${Math.round(meters)} m`
  }

  const kilometers = meters / 1000
  const rounded = Math.round(kilometers * 10) / 10
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)
  return `${text} km`
}
