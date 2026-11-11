import { formatValidTime } from '../time.js'

// 刻度固定落在整天上：起点始终显示，之后只看 5/10/15/30/45/60 天里
// 当前产品真正有的时效。降水 24h 累计从 +24h 起，所以它的第一格是 +1天，
// 地面天气从 +6h 起，第一格是 +6h；其余刻度两边一致。
// 不放 20 天：6h 段到 +15 天结束，+20 天和 +15 天在索引上只差半格。
const TICK_DAYS = [5, 10, 15, 30, 45, 60]

// 刻度写完整日期后比“+5天”宽得多，相邻太近就跳过，免得文字叠在一起。
const MIN_TICK_GAP = 8

function buildTicks(leads) {
  if (leads.length < 2) return []
  const available = new Set(leads)
  const position = (value) => (leads.indexOf(value) / (leads.length - 1)) * 100
  const ticks = [leads[0]]
  for (const day of TICK_DAYS) {
    const value = day * 24
    if (!available.has(value) || value <= leads[0]) continue
    if (position(value) - position(ticks[ticks.length - 1]) < MIN_TICK_GAP) continue
    ticks.push(value)
  }
  const last = leads[leads.length - 1]
  if (ticks[ticks.length - 1] !== last) ticks.push(last)
  return ticks
}

export default function Timeline({
  init,
  leads,
  lead,
  onLeadChange,
  playing,
  onTogglePlay,
}) {
  const count = leads.length
  const index = Math.max(0, leads.indexOf(lead))
  const progress = count > 1 ? (index / (count - 1)) * 100 : 0

  const tickLeads = buildTicks(leads)
  const tickLeft = (value) => (leads.indexOf(value) / (count - 1)) * 100

  return (
    <footer className="timeline">
      <button
        type="button"
        className="play-btn"
        onClick={onTogglePlay}
        aria-label={playing ? '暂停' : '播放'}
      >
        {playing ? '❚❚' : '▶'}
      </button>

      <div className="slider-wrap">
        <div className="slider-track">
          <div className="slider-progress" style={{ width: `${progress}%` }} />
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, count - 1)}
          step={1}
          value={index}
          onChange={(event) => onLeadChange(leads[Number(event.target.value)])}
          title={formatValidTime(init, lead)}
          aria-label="预报时效"
        />
        <div className="slider-ticks">
          {count > 1
            ? tickLeads.map((value) => (
                <span key={value} style={{ left: `${tickLeft(value)}%` }}>
                  {formatValidTime(init, value)}
                </span>
              ))
            : null}
        </div>
      </div>
    </footer>
  )
}
