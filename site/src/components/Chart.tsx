const SLICE_COLORS = ['#fefefe', '#c9c9c9', '#9b9b9b', '#6e6e6e', '#4b4b4b', '#333333']

export interface Slice {
  label: string
  value: number
}

/** Round a max up to a friendly axis value (1, 1.2, 1.5, 2, 2.5, 3, 4, 5… × power of ten). */
function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  return (steps.find((step) => normalized <= step) ?? 10) * magnitude
}

const compact = (value: number): string =>
  value >= 10_000 ? `${Math.round(value / 1000)}k` : value.toLocaleString()

/** Platform share as a donut. The ring is SVG; labels stay real HTML text. */
export function DonutChart({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((sum, s) => sum + s.value, 0)
  let offset = 0
  const summary = slices
    .map((s) => `${s.label} ${s.value.toLocaleString()} (${total > 0 ? Math.round((s.value / total) * 100) : 0}%)`)
    .join(', ')

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
      <div className="relative size-40 shrink-0">
        <svg
          viewBox="0 0 42 42"
          className="size-full -rotate-90"
          role="img"
          aria-label={`Downloads by platform: ${summary}`}
        >
          <circle cx="21" cy="21" r="15.9155" fill="none" stroke="#2a2a2a" strokeWidth="6" />
          {slices.map((s, i) => {
            const pct = total > 0 ? (s.value / total) * 100 : 0
            const gap = pct > 4 ? 1 : 0
            const dash = Math.max(pct - gap, 0)
            const circle = (
              <circle
                key={s.label}
                cx="21"
                cy="21"
                r="15.9155"
                fill="none"
                stroke={SLICE_COLORS[i % SLICE_COLORS.length]}
                strokeWidth="6"
                pathLength={100}
                strokeDasharray={`${dash} ${100 - dash}`}
                strokeDashoffset={-offset}
              >
                <title>{`${s.label}: ${s.value.toLocaleString()} downloads`}</title>
              </circle>
            )
            offset += pct
            return circle
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[22px] leading-none font-medium tabular-nums">
            {compact(total)}
          </span>
          <span className="mt-1 text-[11px] text-[#6a6a6a]">downloads</span>
        </div>
      </div>

      <ul className="w-full min-w-0 space-y-2.5">
        {slices.map((s, i) => (
          <li key={s.label} className="flex min-w-0 items-center gap-2.5 text-[13px]">
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="shrink-0 tabular-nums">{s.value.toLocaleString()}</span>
            <span className="w-11 shrink-0 text-right text-[#6a6a6a] tabular-nums">
              {total > 0 ? `${Math.round((s.value / total) * 100)}%` : '0%'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface Point {
  label: string
  value: number
  date: string | null
}

/**
 * Cumulative downloads, placed at each release's publish date. There is no
 * per-day history in the GitHub API, so this is a step-shaped outline, not a
 * daily time series.
 */
export function CumulativeChart({ points }: { points: Point[] }) {
  const max = niceCeil(points[points.length - 1]?.value ?? 0)
  const lastIndex = Math.max(points.length - 1, 1)
  // Space points by publish date when we can, so a six-week gap looks wider
  // than a three-day one. Falls back to even spacing without usable dates.
  const times = points.map((p) => (p.date ? Date.parse(p.date) : Number.NaN))
  const span = times[times.length - 1]! - times[0]!
  const dated = points.length > 1 && times.every(Number.isFinite) && span > 0
  const coords = points.map((p, i) => ({
    x: dated ? ((times[i]! - times[0]!) / span) * 100 : points.length === 1 ? 50 : (i / lastIndex) * 100,
    y: 100 - (p.value / max) * 100,
    ...p,
  }))

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ')
  const area =
    coords.length > 0
      ? `${line} L ${coords[coords.length - 1]!.x.toFixed(2)},100 L ${coords[0]!.x.toFixed(2)},100 Z`
      : ''

  const labelAt = (index: number) => {
    const date = points[index]?.date
    if (!date) return ''
    return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  return (
    <div>
      <div className="flex gap-3">
        <div className="flex h-40 w-8 shrink-0 flex-col justify-between text-right text-[10px] text-[#6a6a6a] tabular-nums">
          <span>{compact(max)}</span>
          <span>{compact(Math.round(max / 2))}</span>
          <span>0</span>
        </div>
        <div
          className="relative h-40 min-w-0 flex-1"
          role="img"
          aria-label={`Cumulative downloads: ${points.map((p) => `${p.label} ${p.value.toLocaleString()}`).join(', ')}`}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-[#2f2f2f]" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-[#2f2f2f]" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-[#2f2f2f]" />

          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full"
            aria-hidden="true"
          >
            {area ? <path d={area} fill="#fefefe" fillOpacity="0.07" /> : null}
            {coords.length > 1 ? (
              <path
                d={line}
                fill="none"
                stroke="#fefefe"
                strokeWidth="1.5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>

          {coords.map((c) => (
            <span
              key={c.label}
              title={`${c.label}: ${c.value.toLocaleString()} total`}
              className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#fefefe]"
              style={{ left: `${c.x}%`, top: `${c.y}%` }}
            />
          ))}
        </div>
      </div>

      <div className="mt-2 flex justify-between pl-11 text-[10px] text-[#6a6a6a]">
        <span>{labelAt(0)}</span>
        {points.length > 2 ? <span>{labelAt(Math.floor((points.length - 1) / 2))}</span> : null}
        <span>{labelAt(points.length - 1)}</span>
      </div>
    </div>
  )
}
