import { createColormap, formatTick } from '../colormap.js'

// 分级色标的 cmap.ticks 是空的，用分级边界当刻度；位置太挤时抽稀，
// 保证大字号下相邻标签不叠在一起。
function legendTicks(cmap) {
  if (cmap.ticks?.length) return cmap.ticks
  const edges = cmap.edges
  const span = cmap.hi - cmap.lo
  if (!edges?.length || !(span > 0)) return []

  const ticks = []
  let lastPos = -Infinity
  for (const value of edges) {
    if (value < cmap.lo || value > cmap.hi) continue
    const pos = ((value - cmap.lo) / span) * 100
    if (pos - lastPos < 14) continue
    ticks.push({ value, pos })
    lastPos = pos
  }
  if (!ticks.length || ticks[ticks.length - 1].pos < 88) {
    ticks.push({ value: cmap.hi, pos: 100 })
  }
  return ticks
}

// 分级色标按边界切成硬色块，色块位置和刻度对齐，和地图上的离散填色一致
function classGradient(cmap) {
  const { edges, lo, hi } = cmap
  const rows = cmap.classes?.filter((row) => row.color) ?? []
  if (!edges?.length || !rows.length || !(hi > lo)) return cmap.gradientCss

  const pct = (value) => ((value - lo) / (hi - lo)) * 100
  const stops = []
  for (let i = 0; i < edges.length - 1; i += 1) {
    const color = rows[i]?.color
    if (!color) continue
    const from = pct(Math.max(edges[i], lo))
    const to = pct(Math.min(edges[i + 1], hi))
    if (to > from) {
      stops.push(`rgb(${color.join(', ')}) ${from}% ${to}%`)
    }
  }
  const lastColor = rows[rows.length - 1]?.color
  const lastFrom = pct(Math.max(edges[edges.length - 1], lo))
  if (lastColor && lastFrom < 100) {
    stops.push(`rgb(${lastColor.join(', ')}) ${lastFrom}% 100%`)
  }
  return stops.length
    ? `linear-gradient(to right, ${stops.join(', ')})`
    : cmap.gradientCss
}

export default function Legend({ variable }) {
  if (!variable) return null

  const cmap = createColormap(variable)
  const ticks = legendTicks(cmap)
  const last = ticks.length - 1
  const gradient = cmap.kind === 'classes' ? classGradient(cmap) : cmap.gradientCss

  return (
    <div className="legend">
      <div className="legend-bar" style={{ background: gradient }} />
      <div className="legend-ticks">
        {ticks.map((tick, index) => (
          <span
            key={`${tick.value}-${index}`}
            className={index === 0 ? 'is-start' : index === last ? 'is-end' : ''}
            style={{ left: `${tick.pos}%` }}
          >
            {formatTick(tick.value)}
          </span>
        ))}
      </div>
    </div>
  )
}
