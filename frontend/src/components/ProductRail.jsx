import { PRODUCT_BY_ID, RAIN_WINDOWS } from '../products.js'

// 侧栏按业务层次分组：降水 / 地面 / 高空 / 海洋。
// 产品名称统一成「XX图 / XX场」，不放「温湿风」三合一填色。
const PRODUCT_GROUPS = [
  { title: '降水', ids: ['rain'] },
  { title: '地面', ids: ['surface', 't2m', 'wind', 'tdiff', 'pdiff'] },
  { title: '高空', ids: ['z500', 't850', 'q850'] },
  { title: '海洋', ids: ['analysis'] },
]

function toggleClass(on) {
  return `switch${on ? ' is-on' : ''}`
}

export default function ProductRail({
  productId,
  onProductChange,
  rainWindow,
  onRainWindowChange,
  overlays,
  onToggleOverlay,
  barbLevel,
  onBarbLevelChange,
  currentVariable,
  validTime,
}) {
  const contoursAvailable = Boolean(currentVariable?.contour)

  return (
    <aside className="rail">
      <div className="product-list">
        {PRODUCT_GROUPS.map((group) => (
          <div className="product-group" key={group.title}>
            <div className="rail-title">{group.title}</div>
            {group.ids.map((id) => {
              const product = PRODUCT_BY_ID[id]
              if (!product) return null
              return (
                <button
                  key={product.id}
                  type="button"
                  className={`product-btn${product.id === productId ? ' is-active' : ''}`}
                  onClick={() => onProductChange(product.id)}
                >
                  <span className="product-label">{product.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {productId === 'rain' ? (
        <section className="rail-group">
          <div className="rail-title">累计时段</div>
          <div className="segmented">
            {RAIN_WINDOWS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`segmented-btn${item.id === rainWindow ? ' is-active' : ''}`}
                onClick={() => onRainWindowChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rail-group">
        <button
          type="button"
          className="toggle-row"
          onClick={() => onToggleOverlay('contours')}
          aria-pressed={overlays.contours}
          disabled={!contoursAvailable}
        >
          <span className={toggleClass(overlays.contours)} aria-hidden="true" />
          <span className="toggle-text">等值线</span>
        </button>

        <button
          type="button"
          className="toggle-row"
          onClick={() => onToggleOverlay('barbs')}
          aria-pressed={overlays.barbs}
        >
          <span className={toggleClass(overlays.barbs)} aria-hidden="true" />
          <span className="toggle-text">风羽</span>
        </button>

        {overlays.barbs ? (
          <div className="segmented segmented-compact">
            <button
              type="button"
              className={`segmented-btn${barbLevel === '10m' ? ' is-active' : ''}`}
              onClick={() => onBarbLevelChange('10m')}
            >
              10m
            </button>
            <button
              type="button"
              className={`segmented-btn${barbLevel === '850hPa' ? ' is-active' : ''}`}
              onClick={() => onBarbLevelChange('850hPa')}
            >
              850hPa
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="toggle-row"
          onClick={() => onToggleOverlay('places')}
          aria-pressed={overlays.places}
        >
          <span className={toggleClass(overlays.places)} aria-hidden="true" />
          <span className="toggle-text">地名标注</span>
        </button>
      </section>

      <div className="rail-time" title="北京时间（UTC+8）">
        <span className="current-time">{validTime || '—'}</span>
      </div>
    </aside>
  )
}
