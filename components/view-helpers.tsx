"use client"

import type { ReactNode } from "react"

export function SelectPill({
  value,
  onChange,
  options,
  icon,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  icon?: ReactNode
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none h-[32px] rounded-[10px] bg-white/90 pl-2.5 pr-6 text-[12px] font-medium text-[#1D1D1F] shadow-[0_1px_3px_rgba(0,0,0,0.06)] cursor-pointer outline-none focus:shadow-[0_0_0_2px_#007AFF] transition-shadow"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#86868B]">
        {icon}
      </span>
    </div>
  )
}

export function MetricCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-[16px] bg-white/90 p-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
      <p className="text-[11px] font-medium text-[#86868B] mb-0.5">{label}</p>
      <p className="text-[18px] font-semibold tracking-tight" style={{ color: accent }}>
        {value}
      </p>
    </div>
  )
}
