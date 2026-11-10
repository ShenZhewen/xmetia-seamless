export default function Timeline({
  leads,
  lead,
  onLeadChange,
  playing,
  onTogglePlay,
}) {
  const count = leads.length
  const index = Math.max(0, leads.indexOf(lead))
  const progress = count > 1 ? (index / (count - 1)) * 100 : 0

  const tickLeads = []
  if (count > 1) {
    for (let i = 0; i < 6; i += 1) {
      tickLeads.push(leads[Math.round((i * (count - 1)) / 5)])
    }
  }

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
          aria-label="预报时效"
        />
        <div className="slider-ticks">
          {tickLeads.map((value, i) => (
            <span key={value} style={{ left: `${(i / 5) * 100}%` }}>
              {value}h
            </span>
          ))}
        </div>
      </div>
    </footer>
  )
}
