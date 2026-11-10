export default function TopBar({
  models,
  model,
  onModelChange,
  validTime,
  loading,
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-logo" src="/favicon.svg" alt="" width="26" height="26" />
        <div className="brand-name">xmetai-seamless</div>
      </div>

      <label className="model-select">
        <span className="model-select-label">预报模型</span>
        <select
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
          aria-label="预报模型"
        >
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <div className="topbar-right">
        <div className="valid-time">
          <span className="valid-value">
            {validTime ? `${validTime} UTC` : '—'}
          </span>
        </div>
        {loading ? <span className="top-loading">同步中</span> : null}
      </div>
    </header>
  )
}
