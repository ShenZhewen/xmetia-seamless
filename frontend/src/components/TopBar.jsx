import { formatValidTime } from '../time.js'

export default function TopBar({ init, runs, onInitChange, loading }) {
  const options = Array.isArray(runs) ? runs : []
  const current = init || ''
  const known = options.includes(current)

  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-logo" src="/favicon.svg" alt="" width="26" height="26" />
        <div className="brand-name">xmetai-seamless</div>
      </div>

      <div className="topbar-right">
        <label className="init-picker" title="起报时间（北京时间）">
          <span className="init-label">起报日</span>
          <select
            value={current}
            onChange={(event) => onInitChange(event.target.value)}
            disabled={options.length === 0}
            aria-label="起报日"
          >
            {current && !known ? (
              <option value={current}>{formatValidTime(current)}</option>
            ) : null}
            {!current && options.length === 0 ? <option value="">—</option> : null}
            {options.map((value) => (
              <option key={value} value={value}>
                {formatValidTime(value)}
              </option>
            ))}
          </select>
        </label>
        {loading ? <span className="top-loading">同步中</span> : null}
      </div>
    </header>
  )
}
