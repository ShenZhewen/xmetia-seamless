import { displayUnit, formatTick, toDisplay } from '../colormap.js'

const WIDTH = 560
const HEIGHT = 224
const PAD = { left: 50, right: 18, top: 16, bottom: 28 }

function formatLead(leadHours) {
  if (leadHours % 24 === 0) return `+${leadHours / 24}天`
  return `+${Math.floor(leadHours / 24)}天${leadHours % 24}h`
}

function formatCoord(lat, lon) {
  // 数据集经度是 0..360，显示时统一折回 -180..180
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  const latText = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`
  const lonText = `${Math.abs(wrapped).toFixed(2)}°${wrapped >= 0 ? 'E' : 'W'}`
  return `${latText} ${lonText}`
}

// 空值断开折线，不要把缺测连成一条直线
function buildPath(points, x, y) {
  let path = ''
  let open = false
  for (const point of points) {
    if (point.value == null) {
      open = false
      continue
    }
    path += `${open ? 'L' : 'M'}${x(point.lead_hours).toFixed(1)},${y(point.value).toFixed(1)}`
    open = true
  }
  return path
}

function seriesStats(data, variable) {
  if (!data?.points?.length) return null
  let minValue = Infinity
  let maxValue = -Infinity
  let minLead = Infinity
  let maxLead = -Infinity
  let count = 0

  for (const point of data.points) {
    minLead = Math.min(minLead, point.lead_hours)
    maxLead = Math.max(maxLead, point.lead_hours)
    if (point.value == null) continue
    const shown = toDisplay(point.value, variable)
    minValue = Math.min(minValue, shown)
    maxValue = Math.max(maxValue, shown)
    count += 1
  }

  if (!count) return null
  let lo = minValue
  let hi = maxValue
  if (hi - lo < 1e-6) {
    lo -= 1
    hi += 1
  } else {
    const padding = (hi - lo) * 0.08
    lo -= padding
    hi += padding
  }
  return { lo, hi, minLead, maxLead, grid: data.grid, count }
}

export default function PointSeries({
  series,
  variable,
  lead,
  pick,
  onClose,
}) {
  const data = series?.data ?? null
  const loading = Boolean(series?.loading)
  const errorText = series?.error
  // 24/48/72h 累计量在起算时效之前没有值，曲线上也不该留一段空档
  const minLead = variable?.min_lead ?? 0
  const points = (data?.points ?? []).filter(
    (point) => point.lead_hours >= minLead,
  )
  const stats = seriesStats(points.length ? { points, grid: data?.grid } : null, variable)

  const innerW = WIDTH - PAD.left - PAD.right
  const innerH = HEIGHT - PAD.top - PAD.bottom

  let x = () => PAD.left
  let y = () => PAD.top + innerH
  let yDisplay = () => PAD.top + innerH
  if (stats) {
    const spanLead = Math.max(1, stats.maxLead - stats.minLead)
    const spanValue = stats.hi - stats.lo
    x = (leadHours) =>
      PAD.left + ((leadHours - stats.minLead) / spanLead) * innerW
    yDisplay = (shown) =>
      PAD.top + (1 - (shown - stats.lo) / spanValue) * innerH
    y = (rawValue) => yDisplay(toDisplay(rawValue, variable))
  }

  const yTicks = []
  const xTicks = []
  if (stats) {
    for (let i = 0; i <= 4; i += 1) {
      const value = stats.lo + ((stats.hi - stats.lo) * i) / 4
      yTicks.push({ value, pos: yDisplay(value) })
    }
    const indexes = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
      Math.round(fraction * (points.length - 1)),
    )
    for (const index of indexes) {
      const point = points[index]
      if (point) xTicks.push({ label: formatLead(point.lead_hours), pos: x(point.lead_hours) })
    }
  }

  const currentPoint = points.find((point) => point.lead_hours === lead)
  const currentShown =
    currentPoint?.value != null ? toDisplay(currentPoint.value, variable) : null
  const unit = displayUnit(variable)
  const period =
    data?.window_hours
      ? `${data.window_hours}h 累计`
      : data?.lag_hours
        ? `较 ${data.lag_hours}h 前`
        : ''

  return (
    <section className="series-drawer" aria-label="格点逐时效曲线">
      <header className="series-head">
        <div>
          <div className="series-title">{variable?.label ?? ''}</div>
          <div className="series-meta">
            {stats?.grid
              ? `最近格点 ${formatCoord(stats.grid.lat, stats.grid.lon)}`
              : pick
                ? `点选 ${formatCoord(pick.lat, pick.lon)}`
                : '—'}
            {unit ? ` · ${unit}` : ''}
            {period ? ` · ${period}` : ''}
            {loading ? ' · 读取中…' : stats ? ` · ${stats.count} 个值` : ''}
          </div>
        </div>
        <button type="button" className="series-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>

      {!stats && !loading ? (
        <div className="series-empty">
          没有取到数据{errorText ? `：${errorText}` : ''}
        </div>
      ) : (
        <svg
          className="series-chart"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="逐时效曲线"
        >
          {stats ? (
            <>
              {yTicks.map((tick) => (
                <g key={`y-${tick.value}`}>
                  <line
                    className="series-grid"
                    x1={PAD.left}
                    x2={WIDTH - PAD.right}
                    y1={tick.pos}
                    y2={tick.pos}
                  />
                  <text className="series-axis" x={PAD.left - 7} y={tick.pos + 3} textAnchor="end">
                    {formatTick(tick.value)}
                  </text>
                </g>
              ))}
              {xTicks.map((tick) => (
                <text
                  key={`x-${tick.label}-${tick.pos}`}
                  className="series-axis"
                  x={tick.pos}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                >
                  {tick.label}
                </text>
              ))}
              {stats.minLead <= lead && lead <= stats.maxLead ? (
                <line
                  className="series-now"
                  x1={x(lead)}
                  x2={x(lead)}
                  y1={PAD.top}
                  y2={PAD.top + innerH}
                />
              ) : null}

              <path
                className="series-line"
                d={buildPath(points, x, y)}
                stroke="var(--accent)"
                strokeWidth={2.2}
              />

              {currentPoint?.value != null ? (
                <g>
                  <circle
                    className="series-dot"
                    cx={x(currentPoint.lead_hours)}
                    cy={y(currentPoint.value)}
                    r={4}
                    stroke="var(--accent)"
                  />
                  <text
                    className="series-dot-label"
                    x={Math.min(x(currentPoint.lead_hours) + 8, WIDTH - PAD.right - 4)}
                    y={Math.max(y(currentPoint.value) - 8, PAD.top + 10)}
                    textAnchor={
                      x(currentPoint.lead_hours) > WIDTH - 90 ? 'end' : 'start'
                    }
                  >
                    {formatTick(currentShown)}
                    {unit ? ` ${unit}` : ''}
                  </text>
                </g>
              ) : null}
            </>
          ) : (
            <text className="series-axis" x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle">
              {loading ? '读取中…' : '暂无数据'}
            </text>
          )}
        </svg>
      )}

      <footer className="series-foot">
        {currentPoint
          ? `${formatLead(lead)}：${
              currentShown != null
                ? `${formatTick(currentShown)}${unit ? ` ${unit}` : ''}`
                : '该时效无值'
            }`
          : '点击地图换位置 · Esc 关闭'}
      </footer>
    </section>
  )
}
