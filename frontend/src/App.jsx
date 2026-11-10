import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FieldMap from './components/FieldMap.jsx'
import Legend from './components/Legend.jsx'
import PointSeries from './components/PointSeries.jsx'
import ProductRail from './components/ProductRail.jsx'
import Timeline from './components/Timeline.jsx'
import TopBar from './components/TopBar.jsx'
import { fetchCatalog, fetchField, fetchRuns, fetchSeries } from './api.js'
import {
  PRODUCT_BY_ID,
  RAIN_WINDOWS,
  productForVariable,
} from './products.js'

const CACHE_LIMIT = 12
const DETAIL_CACHE_LIMIT = 8
const WIND_CACHE_LIMIT = 8
const SERIES_CACHE_LIMIT = 24

const RAIN_IDS = RAIN_WINDOWS.map((item) => item.id)

function pad(value) {
  return String(value).padStart(2, '0')
}

function computeValidTime(init, lead) {
  if (!init) return ''
  const year = Number(init.slice(0, 4))
  const month = Number(init.slice(4, 6)) - 1
  const day = Number(init.slice(6, 8))
  const hour = init.length >= 10 ? Number(init.slice(8, 10)) : 0
  const date = new Date(Date.UTC(year, month, day, hour + lead))
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-` +
    `${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:00`
  )
}

function trimCache(cache, limit) {
  while (cache.size > limit) {
    cache.delete(cache.keys().next().value)
  }
}

const params = new URLSearchParams(window.location.search)

function readNumber(key) {
  const raw = params.get(key)
  if (raw == null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

// URL 里只存中心点和缩放级别；视窗四界等地图加载后由 moveend 回填
const INITIAL_VIEW = {
  lon: readNumber('lon') ?? 105,
  lat: readNumber('lat') ?? 32,
  zoom: readNumber('z'),
}

// 首屏状态：优先认 URL 里的 product，再按 var 反推产品
function initialProductState() {
  const urlVar = params.get('var')
  const requested = params.get('product')
  const productId =
    requested && PRODUCT_BY_ID[requested]
      ? requested
      : productForVariable(urlVar || 'TP24')
  const product = PRODUCT_BY_ID[productId] ?? PRODUCT_BY_ID.custom

  let variable = urlVar || product.variable || 'T2M'
  if (product.rain) {
    variable = RAIN_IDS.includes(urlVar) ? urlVar : 'TP24'
  } else if (product.variable) {
    variable = product.variable
  }

  return {
    productId,
    variable,
    rainWindow: RAIN_IDS.includes(variable) ? variable : 'TP24',
    overlays: {
      contours: Boolean(product.overlays?.contours),
      barbs: Boolean(product.overlays?.barbs),
      places: true,
    },
    barbLevel: product.barbLevel ?? '10m',
  }
}

const INITIAL_PRODUCT = initialProductState()

// 放大到 z>=5 才值得按视窗取原始分辨率；再低说明视窗比一块 0.5° 数据还大
function detailRequest(view) {
  if (!view || !(view.zoom >= 5)) return null
  const span = view.east - view.west
  if (!(span > 0) || span >= 340) return null
  if (
    !Number.isFinite(view.west) ||
    !Number.isFinite(view.east) ||
    !Number.isFinite(view.south) ||
    !Number.isFinite(view.north)
  ) {
    return null
  }

  let lon0 = ((view.west % 360) + 360) % 360
  let lon1 = lon0 + span
  // 视窗跨数据经度接缝（0°/360°）时只能取其中一半，另一半继续用全球图
  if (lon1 > 360) lon1 = 360

  // 四周多取 12%，小幅拖动时不用马上重新请求
  const padLon = span * 0.12
  lon0 = Math.max(0, lon0 - padLon)
  lon1 = Math.min(360, lon1 + padLon)
  if (!(lon1 - lon0 > 1)) return null

  const latPad = (view.north - view.south) * 0.12
  const lat0 = Math.max(-85, view.south - latPad)
  const lat1 = Math.min(85, view.north + latPad)
  if (!(lat1 - lat0 > 0.4)) return null

  const stride = view.zoom >= 6 ? 1 : 2
  return {
    bbox: [lon0, lat0, lon1, lat1].map((item) => Number(item.toFixed(3))),
    stride,
  }
}

export default function App() {
  const [catalog, setCatalog] = useState(null)
  const [runs, setRuns] = useState([])
  const [model, setModel] = useState(params.get('model') || 'fuxi')
  const [init, setInit] = useState(params.get('init') || '')
  const [productId, setProductId] = useState(INITIAL_PRODUCT.productId)
  const [variableId, setVariableId] = useState(INITIAL_PRODUCT.variable)
  const [rainWindow, setRainWindow] = useState(INITIAL_PRODUCT.rainWindow)
  const [overlays, setOverlays] = useState(INITIAL_PRODUCT.overlays)
  const [barbLevel, setBarbLevel] = useState(INITIAL_PRODUCT.barbLevel)
  const [lead, setLead] = useState(Number(params.get('lead')) || 6)
  const [field, setField] = useState(null)
  const [oceanField, setOceanField] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [view, setView] = useState(INITIAL_VIEW)
  const [detailField, setDetailField] = useState(null)
  const [windField, setWindField] = useState(null)
  const [pick, setPick] = useState(null)
  const [series, setSeries] = useState(null)

  const cacheRef = useRef(new Map())
  const requestsRef = useRef(new Map())
  const detailCacheRef = useRef(new Map())
  const windCacheRef = useRef(new Map())
  const seriesCacheRef = useRef(new Map())
  const leadRef = useRef(lead)

  // 点序列请求用数据集经度（0..360）
  const pickLat = pick ? Number(pick.lat.toFixed(3)) : null
  const pickLon = pick
    ? Number((((pick.lon % 360) + 360) % 360).toFixed(3))
    : null

  useEffect(() => {
    leadRef.current = lead
  }, [lead])

  const putCache = useCallback((key, data) => {
    const cache = cacheRef.current
    if (cache.has(key)) cache.delete(key)
    cache.set(key, data)
    trimCache(cache, CACHE_LIMIT)
  }, [])

  const requestField = useCallback((key, query) => {
    let promise = requestsRef.current.get(key)
    if (!promise) {
      promise = fetchField(query).finally(() => {
        if (requestsRef.current.get(key) === promise) {
          requestsRef.current.delete(key)
        }
      })
      requestsRef.current.set(key, promise)
    }
    return promise
  }, [])

  // 变量表 / 时效网格
  useEffect(() => {
    fetchCatalog()
      .then((data) => {
        setCatalog(data)
        setModel((current) =>
          data.models?.some((item) => item.id === current)
            ? current
            : (data.models?.[0]?.id ?? current),
        )
        setVariableId((current) =>
          data.variables?.some((item) => item.id === current)
            ? current
            : (data.variables?.[0]?.id ?? current),
        )
      })
      .catch((err) => setError(err.message))
  }, [])

  // 起报列表
  useEffect(() => {
    let cancelled = false
    fetchRuns(model)
      .then((data) => {
        if (cancelled) return
        const inits = data.inits ?? []
        setRuns(inits)
        setInit((current) =>
          inits.includes(current) ? current : (inits[0] ?? ''),
        )
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [model])

  const variable = useMemo(
    () => catalog?.variables?.find((item) => item.id === variableId),
    [catalog, variableId],
  )

  // 等压线这类产品只画线不画填色
  const activeProduct = PRODUCT_BY_ID[productId] ?? PRODUCT_BY_ID.custom
  const showFill = !activeProduct.noFill

  // 海洋与地面：主填色是地面气压，海面再叠一层海温（变量目录里有才取）
  const oceanVarId = activeProduct.oceanVar ?? null
  const oceanVariable = useMemo(
    () => catalog?.variables?.find((item) => item.id === oceanVarId) ?? null,
    [catalog, oceanVarId],
  )

  const minLead = variable?.min_lead ?? catalog?.step_hours ?? 6
  const windVar = barbLevel === '850hPa' ? 'WSPD850' : 'WSPD10'

  // 产品/要素限制时效：累计量和变化量在窗口不够长时没有值
  const leads = useMemo(
    () => (catalog?.leads ?? []).filter((value) => value >= minLead),
    [catalog, minLead],
  )

  useEffect(() => {
    if (!leads.length) return
    if (!leads.includes(lead)) setLead(leads[0])
  }, [leads, lead])

  // 当前场
  useEffect(() => {
    if (!init) return undefined
    if (lead < minLead) return undefined
    if (runs.length && !runs.includes(init)) return undefined

    const key = `${model}|${init}|${variableId}|${lead}`
    const cached = cacheRef.current.get(key)
    if (cached) {
      cacheRef.current.delete(key)
      cacheRef.current.set(key, cached)
      setField(cached)
      setLoading(false)
      setError('')
      return undefined
    }

    let cancelled = false
    setLoading(true)
    setError('')
    requestField(key, { model, init, variable: variableId, lead })
      .then((data) => {
        if (cancelled) return
        putCache(key, data)
        setField(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [model, init, variableId, lead, minLead, runs, requestField, putCache])

  // 换模型/起报/变量/时效时，上一帧的高分辨率块已经对不上，先撤掉
  useEffect(() => {
    setDetailField(null)
  }, [model, init, variableId, lead])

  // 放大后按视窗取一块原始分辨率数据；播放时不取，避免每 650ms 一堆请求
  useEffect(() => {
    if (playing) {
      setDetailField(null)
      return undefined
    }
    if (!init || lead < minLead) return undefined
    const request = detailRequest(view)
    if (!request) {
      setDetailField(null)
      return undefined
    }

    const key = `${model}|${init}|${variableId}|${lead}|${request.stride}|${request.bbox.join(',')}`
    const cached = detailCacheRef.current.get(key)
    if (cached) {
      detailCacheRef.current.delete(key)
      detailCacheRef.current.set(key, cached)
      setDetailField(cached)
      return undefined
    }

    let cancelled = false
    const timer = setTimeout(() => {
      fetchField({
        model,
        init,
        variable: variableId,
        lead,
        stride: request.stride,
        bbox: request.bbox,
      })
        .then((data) => {
          detailCacheRef.current.set(key, data)
          trimCache(detailCacheRef.current, DETAIL_CACHE_LIMIT)
          if (!cancelled) setDetailField(data)
        })
        .catch(() => {
          /* 地区块取不到就继续用全球图，不打断浏览 */
        })
    }, 260)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [view, playing, model, init, variableId, lead, minLead])

  // 风羽用的风速场：和主要素分开取，切主要素不用重新算
  useEffect(() => {
    // 主填色本身就是这个风场时，直接复用当前场，不重复请求
    if (!overlays.barbs || !init || variableId === windVar) {
      setWindField(null)
      return undefined
    }
    const key = `wind|${model}|${init}|${windVar}|${lead}`

    const cached = windCacheRef.current.get(key)
    if (cached) {
      windCacheRef.current.delete(key)
      windCacheRef.current.set(key, cached)
      setWindField(cached)
      return undefined
    }

    let cancelled = false
    fetchField({ model, init, variable: windVar, lead })
      .then((data) => {
        windCacheRef.current.set(key, data)
        trimCache(windCacheRef.current, WIND_CACHE_LIMIT)
        if (!cancelled) setWindField(data)
      })
      .catch(() => {
        /* 风羽是叠加层，取不到就暂时不画，不打断主图 */
      })
    return () => {
      cancelled = true
    }
  }, [overlays.barbs, barbLevel, windVar, model, init, lead, variableId])

  // 海温叠加场：只有「海洋与地面」产品需要；缺数据时静默跳过，不影响主图
  useEffect(() => {
    if (!oceanVariable || !init) {
      setOceanField(null)
      return undefined
    }
    if (lead < (oceanVariable.min_lead ?? catalog?.step_hours ?? 6)) {
      setOceanField(null)
      return undefined
    }
    if (runs.length && !runs.includes(init)) return undefined

    const key = `${model}|${init}|${oceanVariable.id}|${lead}`
    const cached = cacheRef.current.get(key)
    if (cached) {
      setOceanField(cached)
      return undefined
    }

    let cancelled = false
    requestField(key, { model, init, variable: oceanVariable.id, lead })
      .then((data) => {
        putCache(key, data)
        if (!cancelled) setOceanField(data)
      })
      .catch(() => {
        /* 海温缺数据就先不画海面填色 */
        if (!cancelled) setOceanField(null)
      })
    return () => {
      cancelled = true
    }
  }, [
    oceanVariable,
    model,
    init,
    lead,
    runs,
    catalog,
    requestField,
    putCache,
  ])

  // 点选格点的逐时效序列：换模型/起报/要素或点新位置都重新取
  useEffect(() => {
    if (pickLat == null || pickLon == null || !init || !variableId) {
      setSeries(null)
      return undefined
    }
    const key = `${model}|${init}|${variableId}|${pickLat}|${pickLon}`
    const cache = seriesCacheRef.current
    const cached = cache.get(key)
    if (cached) {
      cache.delete(key)
      cache.set(key, cached)
      setSeries({ loading: false, data: cached, error: '' })
      return undefined
    }

    let cancelled = false
    setSeries({ loading: true, data: null, error: '' })
    fetchSeries({
      model,
      init,
      variable: variableId,
      lat: pickLat,
      lon: pickLon,
    })
      .then((data) => {
        if (cancelled) return
        cache.set(key, data)
        trimCache(cache, SERIES_CACHE_LIMIT)
        setSeries({ loading: false, data, error: '' })
      })
      .catch((err) => {
        if (!cancelled) {
          setSeries({ loading: false, data: null, error: err.message })
        }
      })
    return () => {
      cancelled = true
    }
  }, [pickLat, pickLon, model, init, variableId])

  // 预取后面两个时效，播放/拖动时间轴时不至于每帧都等网络
  useEffect(() => {
    if (!init || !leads.length) return
    const index = leads.indexOf(lead)
    if (index < 0) return
    for (const step of [1, 2]) {
      const nextLead = leads[index + step]
      if (nextLead == null) continue
      const key = `${model}|${init}|${variableId}|${nextLead}`
      if (cacheRef.current.has(key) || requestsRef.current.has(key)) continue
      requestField(key, {
        model,
        init,
        variable: variableId,
        lead: nextLead,
      })
        .then((data) => putCache(key, data))
        .catch(() => {
          /* 预取失败不打扰用户，走到那一步时会正常报错 */
        })
    }
  }, [model, init, variableId, lead, leads, requestField, putCache])

  // 逐时效播放：到最后一个时自动停，不循环回开头
  useEffect(() => {
    if (!playing || !leads.length) return undefined
    const timer = setInterval(() => {
      const index = leads.indexOf(leadRef.current)
      if (index >= leads.length - 1) {
        setPlaying(false)
        return
      }
      setLead(leads[index + 1])
    }, 650)
    return () => clearInterval(timer)
  }, [playing, leads])

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (leads.length && leadRef.current === leads[leads.length - 1]) {
      setLead(leads[0])
    }
    setPlaying(true)
  }, [playing, leads])

  // 键盘：左右调时效，空格播放/暂停
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setPick(null)
        return
      }
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (!leads.length) return
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        const direction = event.key === 'ArrowRight' ? 1 : -1
        setLead((current) => {
          const index = leads.indexOf(current)
          if (index < 0) return leads[0]
          const next = (index + direction + leads.length) % leads.length
          return leads[next]
        })
      } else if (event.code === 'Space') {
        event.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [leads, togglePlay])

  // URL 状态：复制地址即可还原当前视图（含地图位置）
  useEffect(() => {
    if (!init) return
    const query = new URLSearchParams()
    query.set('model', model)
    query.set('init', init)
    query.set('product', productId)
    query.set('var', variableId)
    query.set('lead', String(lead))
    if (Number.isFinite(view.lon)) query.set('lon', view.lon.toFixed(3))
    if (Number.isFinite(view.lat)) query.set('lat', view.lat.toFixed(3))
    if (Number.isFinite(view.zoom)) query.set('z', view.zoom.toFixed(2))
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${query.toString()}`,
    )
  }, [model, init, productId, variableId, lead, view.lon, view.lat, view.zoom])

  const handleViewChange = useCallback((next) => {
    setView(next)
  }, [])

  const handlePick = useCallback((next) => {
    if (!next) return
    setPick({ lat: next.lat, lon: next.lon })
  }, [])

  const closeSeries = useCallback(() => {
    setPick(null)
    setSeries(null)
  }, [])

  const handleProductChange = useCallback(
    (nextId) => {
      const next = PRODUCT_BY_ID[nextId]
      if (!next) return
      setProductId(nextId)
      if (nextId === 'custom') return
      setOverlays((current) => ({
        ...current,
        contours: Boolean(next.overlays?.contours),
        barbs: Boolean(next.overlays?.barbs),
      }))
      if (next.barbLevel) setBarbLevel(next.barbLevel)
      if (next.rain) {
        setVariableId(rainWindow)
      } else if (next.variable) {
        setVariableId(next.variable)
      }
    },
    [rainWindow],
  )

  const handleRainWindowChange = useCallback((id) => {
    setProductId('rain')
    setRainWindow(id)
    setVariableId(id)
  }, [])

  const handleToggleOverlay = useCallback((name) => {
    setOverlays((current) => ({ ...current, [name]: !current[name] }))
  }, [])

  const fieldMatches =
    field &&
    field.model === model &&
    field.init === init &&
    field.var === variableId &&
    field.lead_hours === lead

  // 换模型/起报时不让旧场继续冒充，换时效则保留上一帧直到新帧到达
  const visibleField =
    field && field.model === model && field.init === init && field.var === variableId
      ? field
      : null

  const validTime =
    fieldMatches && field.valid_time
      ? field.valid_time
      : computeValidTime(init, lead)

  // 海温层和主图同模型/起报，换时效时保留上一帧直到新帧到达
  const visibleOceanField =
    oceanField &&
    oceanVariable &&
    oceanField.model === model &&
    oceanField.init === init &&
    oceanField.var === oceanVariable.id
      ? oceanField
      : null

  const visibleWindField =
    windField &&
    windField.model === model &&
    windField.init === init &&
    windField.var === windVar &&
    windField.lead_hours === lead
      ? windField
      : null

  const barbsWindField = overlays.barbs
    ? fieldMatches && field.var === windVar
      ? field
      : visibleWindField
    : null

  return (
    <div className="app">
      <TopBar
        models={catalog?.models ?? []}
        model={model}
        onModelChange={setModel}
        validTime={validTime}
        loading={loading}
      />

      <div className="workspace">
        <ProductRail
          productId={productId}
          onProductChange={handleProductChange}
          rainWindow={rainWindow}
          onRainWindowChange={handleRainWindowChange}
          overlays={overlays}
          onToggleOverlay={handleToggleOverlay}
          barbLevel={barbLevel}
          onBarbLevelChange={setBarbLevel}
          currentVariable={variable}
        />

        <main className="stage">
          <FieldMap
            field={visibleField}
            variable={variable}
            oceanField={visibleOceanField}
            oceanVariable={oceanVariable}
            showFill={showFill}
            loading={loading}
            detailField={detailField}
            view={INITIAL_VIEW}
            onViewChange={handleViewChange}
            showContours={overlays.contours}
            showBarbs={overlays.barbs}
            showPlaces={overlays.places}
            windField={barbsWindField}
            pick={pick}
            onPick={handlePick}
          />
          {showFill && !error ? <Legend variable={variable} /> : null}
          {pick ? (
            <PointSeries
              series={series}
              model={
                catalog?.models?.find((item) => item.id === model) ?? null
              }
              variable={variable}
              lead={lead}
              pick={pick}
              onClose={closeSeries}
            />
          ) : null}
          {error ? <div className="error-banner">{error}</div> : null}
        </main>
      </div>

      <Timeline
        leads={leads}
        lead={lead}
        onLeadChange={setLead}
        playing={playing}
        onTogglePlay={togglePlay}
      />
    </div>
  )
}
