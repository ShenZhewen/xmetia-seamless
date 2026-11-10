import { PRODUCTS, RAIN_WINDOWS } from '../products.js'

// 侧栏先只放这些业务产品；products.js 里其余定义保留，
// 以后要加回来直接往这个数组里加 id 即可。
const VISIBLE_PRODUCTS = [
  'rain',
  'surface',
  'z500',
  't850',
  't2m',
  'wind',
  'analysis',
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
}) {
  const contoursAvailable = Boolean(currentVariable?.contour)

  return (
    <aside className="rail">
      <div className="product-list">
        {PRODUCTS.filter((product) => VISIBLE_PRODUCTS.includes(product.id)).map(
          (product) => (
            <button
              key={product.id}
              type="button"
              className={`product-btn${product.id === productId ? ' is-active' : ''}`}
              onClick={() => onProductChange(product.id)}
            >
              <span className="product-label">{product.label}</span>
            </button>
          ),
        )}
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
    </aside>
  )
}
