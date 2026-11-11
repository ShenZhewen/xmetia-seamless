import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// Vite 会把 maplibre-gl 预打包进 .vite/deps，库内按 import.meta.url 拼出的
// worker 地址会 404。worker 文件是自包含的，直接作为资源导入再显式指定。
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { feature, mesh } from 'topojson-client'
import countriesTopo from 'world-atlas/countries-50m.json'
import landTopo from 'world-atlas/land-50m.json'
// 中国省级界线：Natural Earth 1:50m admin-1（公有领域），与底图同源。
import chinaProvinces from '../assets/china-provinces.json'
import {
  contourLevels,
  createColormap,
  displayUnit,
  toDisplay,
} from '../colormap.js'
import {
  MAX_LAT,
  fieldContains,
  sampleFieldValue,
  sampleFieldValueSmooth,
  toMapLon,
} from '../fieldImage.js'
import { imageUrl } from '../api.js'
import { isLand, landMaskReady } from '../landMask.js'
import { buildContours } from '../contours.js'
import { drawWindBarbs } from '../windBarbs.js'
import { drawAnnotations } from '../annotations.js'
import { drawStarfield } from '../starfield.js'

setWorkerUrl(maplibreWorkerUrl)

const WORLD_COORDS = [
  [-180, MAX_LAT],
  [180, MAX_LAT],
  [180, -MAX_LAT],
  [-180, -MAX_LAT],
]

// 用 step 而不是 interpolate：z<3 是纯球面，放大越过 3 直接切成平面，
// 不要中间那种既不是球也不是平面的过渡态。
// 首屏（URL 里没有 z）落在球面段，放大越过 3 才切成平面。
const PROJECTION_SWITCH_ZOOM = 3.0
// 球面/平面切换的视野落差：跨过阈值时平面再往里推一档（反向就退一档），
// 球面最后一帧看到亚洲，平面第一帧直接是中国的尺度，不做同比例尺的无缝对接。
const PROJECTION_ZOOM_GAP = 1.0
const MIN_ZOOM = 0.7
const PROJECTION = {
  type: [
    'step',
    ['zoom'],
    'vertical-perspective',
    PROJECTION_SWITCH_ZOOM,
    'mercator',
  ],
}

const EMPTY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// image source 只能覆盖 Mercator 世界（±85.0511°），球面模式下两极会露出一个
// 没有填色的黑洞。按经度切成一条条贴着世界顶/底边的细长多边形：MapLibre 的
// 球面细分会把每条的填充一直补到极点，颜色逐条取自极圈内侧边缘的真实场值，
// 所以极区是跟着周围场走的，不再是一整块单色圆盘。
const POLAR_CAP_INNER_LAT = 84.55
const POLAR_CAP_SECTOR = 1
const POLAR_CAP_OCEAN = '#050a12'

function polarCapData(
  field,
  variable,
  landOnly = false,
  palettes = null,
  oceanField = null,
  oceanVariable = null,
) {
  const cmap = field && variable ? createColormap(variable, palettes) : null
  const oceanCmap =
    oceanField && oceanVariable
      ? createColormap(oceanVariable, palettes)
      : null
  const colorAt = (lat, lon) => {
    if (!cmap) return POLAR_CAP_OCEAN
    const sign = lat < 0 ? -1 : 1
    // 取极冠内侧边缘（84.55°）的颜色，和贴图边缘接上；缺测时往里退两档
    for (const probe of [POLAR_CAP_INNER_LAT, 84.2, 83.4]) {
      const probeLat = sign * probe
      const isOceanSector = landOnly && !isLand(probeLat, lon)
      // 海洋与地面：海面用海温层，没有海温数据时才留底色
      if (isOceanSector) {
        if (!oceanCmap) return POLAR_CAP_OCEAN
        const value = sampleFieldValueSmooth(oceanField, probeLat, lon)
        if (value == null) continue
        const rgba = oceanCmap.rgba(toDisplay(value, oceanVariable))
        if (!rgba || rgba[3] === 0) return POLAR_CAP_OCEAN
        return `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`
      }
      const value = sampleFieldValueSmooth(field, probeLat, lon)
      if (value == null) continue
      const rgba = cmap.rgba(toDisplay(value, variable))
      if (!rgba || rgba[3] === 0) return POLAR_CAP_OCEAN
      return `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`
    }
    return POLAR_CAP_OCEAN
  }

  const features = []
  for (const sign of [1, -1]) {
    for (let lon = -180; lon < 180; lon += POLAR_CAP_SECTOR) {
      const next = Math.min(180, lon + POLAR_CAP_SECTOR)
      const midLon = (((lon + next) / 2) % 360 + 360) % 360
      features.push({
        type: 'Feature',
        properties: {
          color: colorAt(sign * POLAR_CAP_INNER_LAT, midLon),
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [lon, sign * POLAR_CAP_INNER_LAT],
              [next, sign * POLAR_CAP_INNER_LAT],
              [next, sign * MAX_LAT],
              [lon, sign * MAX_LAT],
              [lon, sign * POLAR_CAP_INNER_LAT],
            ],
          ],
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

const EMPTY_LINES = { type: 'FeatureCollection', features: [] }

// Natural Earth（world-atlas 打包的 1:50m 版本，公有领域），离线可用。
const LAND = feature(landTopo, landTopo.objects.land)
const COASTLINE = {
  type: 'Feature',
  properties: {},
  geometry: mesh(landTopo, landTopo.objects.land),
}
const BORDERS = {
  type: 'Feature',
  properties: {},
  geometry: mesh(
    countriesTopo,
    countriesTopo.objects.countries,
    (a, b) => a !== b,
  ),
}

function line(coordinates) {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }
}

function graticule(step) {
  const features = []
  for (let lon = -180; lon <= 180; lon += step) {
    features.push(line([[lon, -MAX_LAT], [lon, MAX_LAT]]))
  }
  for (let lat = -60; lat <= 60; lat += step) {
    features.push(line([[-180, lat], [180, lat]]))
  }
  return { type: 'FeatureCollection', features }
}

// 球体底色：海洋和极区本来是透明地露出来的，球面视图下背景透明后
// 星星会从球体内部透出来，所以先铺一层不透明的全球矩形把球体封住。
const OCEAN = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-180, MAX_LAT],
        [180, MAX_LAT],
        [180, -MAX_LAT],
        [-180, -MAX_LAT],
        [-180, MAX_LAT],
      ],
    ],
  },
}

const BASEMAP = {
  version: 8,
  projection: PROJECTION,
  sources: {
    ocean: { type: 'geojson', data: OCEAN },
    land: { type: 'geojson', data: LAND },
    coastline: { type: 'geojson', data: COASTLINE },
    borders: { type: 'geojson', data: BORDERS },
    provinces: { type: 'geojson', data: chinaProvinces },
    graticule10: { type: 'geojson', data: graticule(10) },
    graticule30: { type: 'geojson', data: graticule(30) },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      // 球面段透明，让下面那层星空 canvas 透出来；平面段恢复不透明。
      paint: {
        'background-color': [
          'step',
          ['zoom'],
          'rgba(0,0,0,0)',
          PROJECTION_SWITCH_ZOOM,
          '#050a12',
        ],
      },
    },
    {
      id: 'ocean-fill',
      type: 'fill',
      source: 'ocean',
      paint: { 'fill-color': '#050a12' },
    },
    {
      id: 'land',
      type: 'fill',
      source: 'land',
      paint: { 'fill-color': '#0e1827' },
    },
    {
      id: 'graticule10',
      type: 'line',
      source: 'graticule10',
      paint: {
        'line-color': '#16233a',
        'line-width': 0.4,
        'line-opacity': 0.55,
      },
    },
    {
      id: 'graticule30',
      type: 'line',
      source: 'graticule30',
      paint: {
        'line-color': '#20314d',
        'line-width': 0.6,
        'line-opacity': 0.8,
      },
    },
    // 省界比国境线细、暗一档；全球视角下不显示，放大到东亚尺度再出现。
    {
      id: 'province-lines',
      type: 'line',
      source: 'provinces',
      minzoom: 4,
      paint: {
        'line-color': '#5f7695',
        'line-width': 0.5,
        'line-opacity': 0.72,
      },
    },
    // 国境线用两层：深色描边保证亮色填色上也看得见，
    // 浅蓝灰主线保证深色底图上不消失。
    {
      id: 'borders-casing',
      type: 'line',
      source: 'borders',
      paint: { 'line-color': 'rgba(2, 7, 14, 0.7)', 'line-width': 2.6 },
    },
    {
      id: 'borders',
      type: 'line',
      source: 'borders',
      paint: {
        'line-color': '#b7cae6',
        'line-width': 1,
        'line-opacity': 0.95,
      },
    },
    {
      id: 'coastline',
      type: 'line',
      source: 'coastline',
      paint: { 'line-color': '#5f83b0', 'line-width': 0.9 },
    },
  ],
}

const LAYER_ORDER = 'province-lines'

// 首屏球面：让地球直径约占舞台短边的 88%，并在球面段留一点余量。
// 半径公式与 MapLibre 的 getGlobeRadiusPixels 一致：worldSize/(2π·cos(lat))。
function globeFitZoom(width, height, lat) {
  const radius = Math.min(width || 1200, height || 700) * 0.44
  const scale = Math.max(
    Math.cos((Math.min(Math.abs(lat), 85) * Math.PI) / 180),
    0.2,
  )
  const zoom = Math.log2((radius * 2 * Math.PI * scale) / 512)
  return Math.min(2.8, Math.max(MIN_ZOOM + 0.2, zoom))
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

function formatLat(lat) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`
}

function formatLon(lon) {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  return `${Math.abs(wrapped).toFixed(2)}°${wrapped >= 0 ? 'E' : 'W'}`
}

function formatValue(value, variable) {
  if (value == null) return '—'
  const shown = toDisplay(value, variable)
  const digits = Math.abs(shown) >= 1000 ? 0 : 1
  const text = shown.toFixed(digits)
  const unit = displayUnit(variable)
  return `${text}${unit ? ` ${unit}` : ''}`
}

// 地区块在数据集坐标（经度 0..360）下的范围；服务端按这个 bbox 出图。
function detailBox(detailField) {
  const lats = detailField.lat
  const lons = detailField.lon
  if (!lats?.length || !lons?.length) return null
  return [
    Math.min(lons[0], lons[lons.length - 1]),
    Math.min(lats[0], lats[lats.length - 1]),
    Math.max(lons[0], lons[lons.length - 1]),
    Math.max(lats[0], lats[lats.length - 1]),
  ]
}

function detailGeometry(detailField) {
  const lats = detailField.lat
  const lons = detailField.lon
  if (!lats?.length || !lons?.length) return null
  const south = Math.min(lats[0], lats[lats.length - 1])
  const north = Math.max(lats[0], lats[lats.length - 1])
  const west = toMapLon(Math.min(lons[0], lons[lons.length - 1]))
  const east = toMapLon(Math.max(lons[0], lons[lons.length - 1]))
  // 跨日界线的块 MapLibre 贴不好，宁可退回全球图
  if (!(east > west) || !(north > south)) return null
  return {
    coords: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  }
}

// 后端出图 URL：和 JSON 场同模型/起报/变量/时效，bbox 用数据集经度。
function fieldImageUrl(source, { bbox = null, mask = null } = {}) {
  return imageUrl({
    model: source.model,
    init: source.init,
    variable: source.var,
    lead: source.lead_hours,
    bbox,
    mask,
    projection: 'mercator',
  })
}

export default function FieldMap({
  field,
  variable,
  oceanField = null,
  oceanVariable = null,
  loading,
  detailField,
  view,
  onViewChange,
  showFill = true,
  showContours = false,
  showBarbs = false,
  showPlaces = true,
  windField = null,
  pick = null,
  onPick = null,
  palettes = null,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const onPickRef = useRef(onPick)
  const suppressClickRef = useRef(false)
  const readoutRef = useRef(null)
  const lineHRef = useRef(null)
  const lineVRef = useRef(null)
  const dotRef = useRef(null)
  const annotationCanvasRef = useRef(null)
  const barbsCanvasRef = useRef(null)
  const starCanvasRef = useRef(null)
  const fieldRef = useRef(field)
  const detailRef = useRef(detailField)
  const oceanFieldRef = useRef(oceanField)
  const oceanVariableRef = useRef(oceanVariable)
  const variableRef = useRef(variable)
  const windFieldRef = useRef(windField)
  const labelsRef = useRef([])
  const flagsRef = useRef({ showContours, showBarbs, showPlaces })
  const onViewChangeRef = useRef(onViewChange)
  const scheduleRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)
  // 陆地掩膜是异步读的，读好后补一次重画
  const [maskReady, setMaskReady] = useState(false)

  useEffect(() => {
    let alive = true
    landMaskReady().then(() => {
      if (alive) setMaskReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // 等值线：只在全球场（抽稀后）上算，地区块只用于填色，避免放大后重复计算
  const contours = useMemo(() => {
    if (
      !showContours ||
      !field ||
      !variable ||
      field.var !== variable.id ||
      !variable.contour
    ) {
      return { lines: EMPTY_LINES, labels: [] }
    }
    return buildContours(
      field,
      contourLevels(variable, variable.contour),
      variable,
    )
  }, [field, variable, showContours])

  useEffect(() => {
    fieldRef.current = field
    detailRef.current = detailField
    oceanFieldRef.current = oceanField
    oceanVariableRef.current = oceanVariable
    variableRef.current = variable
    windFieldRef.current = windField
    labelsRef.current = contours.labels
    flagsRef.current = { showContours, showBarbs, showPlaces }
    onViewChangeRef.current = onViewChange
    onPickRef.current = onPick
  }, [
    field,
    detailField,
    oceanField,
    oceanVariable,
    variable,
    windField,
    contours,
    showContours,
    showBarbs,
    showPlaces,
    onViewChange,
    onPick,
  ])

  const drawOverlays = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    // 星空在球面段才画；切平面后地球背景不透明，画了也看不见，直接清掉省 CPU
    drawStarfield(
      starCanvasRef.current,
      map,
      map.getZoom() < PROJECTION_SWITCH_ZOOM,
    )
    const flags = flagsRef.current
    // 风羽只在平面视图画：球面上放不下，读起来也糊成一团
    drawWindBarbs(barbsCanvasRef.current, map, windFieldRef.current, {
      visible: flags.showBarbs && map.getZoom() >= PROJECTION_SWITCH_ZOOM,
    })
    drawAnnotations(annotationCanvasRef.current, map, {
      contourLabels: labelsRef.current,
      showPlaces: flags.showPlaces,
      showContours: flags.showContours,
    })
  }, [])

  // ── 地图初始化（只做一次） ──
  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return undefined

    const width = container.clientWidth || 1200
    const height = container.clientHeight || 700
    const hasView = view && Number.isFinite(view.lon) && Number.isFinite(view.lat)
    const center = hasView ? [toMapLon(view.lon), view.lat] : [105, 32]
    // 第一次打开（URL 里没有 z）直接进球面，正好把中国放在正面
    const initialZoom = Number.isFinite(view?.zoom)
      ? view.zoom
      : globeFitZoom(width, height, center[1])
    const map = new MapLibreMap({
      container,
      style: BASEMAP,
      center,
      zoom: Math.max(MIN_ZOOM, initialZoom),
      minZoom: MIN_ZOOM,
      maxZoom: 9,
      // 球面模式下不能关掉 world copies，否则缩到全球时 MapLibre 会把
      // 中心经度钳到 0，无法把亚洲转到正面；平面业务尺度下看不到重复世界。
      renderWorldCopies: true,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    })
    mapRef.current = map
    map.addControl(
      new NavigationControl({ showCompass: false }),
      'bottom-right',
    )
    map.touchZoomRotate.disableRotation()

    // 球面段接管拖拽：MapLibre 自带的球面拖动在大角度时会向极区偏移并把
    // zoom 一路压低，转到一定程度就像卡住。这里自己算经纬度增量：横向只转
    // 经度（可以一直转 360°），纵向纬度夹在 ±85°，拖动全程不改 zoom。
    let globeMode = null
    let globeDragging = false
    let globeDrag = null
    let panPending = null
    let panFrame = 0

    // 投影由 zoom 表达式驱动：极区补丁只在球面段显示
    const syncProjectionMode = () => {
      const isGlobe = map.getZoom() < PROJECTION_SWITCH_ZOOM
      if (map.getLayer('polar-cap-fill')) {
        map.setLayoutProperty('polar-cap-fill', 'visibility', isGlobe ? 'visible' : 'none')
      }
      if (isGlobe === globeMode) return
      globeMode = isGlobe
      container.classList.toggle('globe-mode', isGlobe)
      if (isGlobe) {
        map.dragPan.disable()
      } else {
        map.dragPan.enable()
        globeDrag = null
        globeDragging = false
        container.classList.remove('is-dragging')
      }
    }

    const onLoad = () => {
      syncProjectionMode()
      // 球面边缘的淡蓝大气光晕；平面段自动淡出，不干扰业务读图。
      // 天空穹顶本身改成透明，否则整屏的深色会盖住背景星空；
      // 地球边缘那圈大气光由单独的 atmosphere pass 画，不受影响。
      map.setSky({
        'sky-color': 'rgba(7,20,38,0)',
        'horizon-color': 'rgba(29,77,122,0)',
        'fog-color': 'rgba(5,10,18,0)',
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4.5, 0],
      })
      map.addSource('field', {
        type: 'image',
        url: EMPTY_PNG,
        coordinates: WORLD_COORDS,
      })
      map.addLayer(
        {
          id: 'field-layer',
          type: 'raster',
          source: 'field',
          paint: {
            'raster-opacity': 0.9,
            'raster-resampling': 'linear',
            'raster-fade-duration': 0,
          },
        },
        LAYER_ORDER,
      )
      map.setLayoutProperty('field-layer', 'visibility', 'none')

      // 球面模式补两极：贴着 ±85.05° 世界边缘的细多边形会被球面细分拉到极点。
      // 平面视图下没有极区可看，直接隐藏，免得在 84.55–85.05° 留一条色带。
      map.addSource('polar-cap', {
        type: 'geojson',
        data: polarCapData(null, null),
      })
      map.addLayer(
        {
          id: 'polar-cap-fill',
          type: 'fill',
          source: 'polar-cap',
          paint: {
            'fill-color': ['get', 'color'],
            // 不透明：极区在 85° 以上没有底图和海面，留透明度会让星空透出来
            'fill-opacity': 1,
          },
        },
        LAYER_ORDER,
      )
      syncProjectionMode()

      // 放大后按视窗取的高分辨率块，盖在全球图上
      map.addSource('field-detail', {
        type: 'image',
        url: EMPTY_PNG,
        coordinates: WORLD_COORDS,
      })
      map.addLayer(
        {
          id: 'field-detail-layer',
          type: 'raster',
          source: 'field-detail',
          paint: {
            'raster-opacity': 0.92,
            'raster-resampling': 'linear',
            'raster-fade-duration': 0,
          },
        },
        LAYER_ORDER,
      )
      map.setLayoutProperty('field-detail-layer', 'visibility', 'none')

      // 海洋与地面产品：海温单独一层铺在海洋上，陆地缺测处透明，
      // 所以下面地面气压的填色在陆地上照常显示。
      map.addSource('ocean-field', {
        type: 'image',
        url: EMPTY_PNG,
        coordinates: WORLD_COORDS,
      })
      map.addLayer(
        {
          id: 'ocean-field-layer',
          type: 'raster',
          source: 'ocean-field',
          paint: {
            'raster-opacity': 0.9,
            'raster-resampling': 'linear',
            'raster-fade-duration': 0,
          },
        },
        LAYER_ORDER,
      )
      map.setLayoutProperty('ocean-field-layer', 'visibility', 'none')

      // 河湖来自 Natural Earth 1:50m，压在填色之上、省界之下；
      // 填色 raster 有 0.9 不透明度，放在底图里会被盖掉，所以单独提到上层。
      map.addSource('water', {
        type: 'geojson',
        data: '/water-50m.geojson',
      })
      map.addLayer(
        {
          id: 'water-lake',
          type: 'fill',
          source: 'water',
          filter: ['==', ['get', 'k'], 'lake'],
          paint: {
            'fill-color': '#2f6f96',
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 4, 0.72],
          },
        },
        LAYER_ORDER,
      )
      map.addLayer(
        {
          id: 'water-river',
          type: 'line',
          source: 'water',
          filter: ['==', ['get', 'k'], 'river'],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#5f9fcd',
            'line-opacity': 0.62,
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              1, 0.45,
              3, 0.7,
              5, 1.1,
              8, 1.8,
            ],
          },
        },
        LAYER_ORDER,
      )

      // 等值线在填色之上；588 线单独一档用暖色强调
      map.addSource('contour-lines', {
        type: 'geojson',
        data: EMPTY_LINES,
      })
      map.addLayer({
        id: 'contour-base',
        type: 'line',
        source: 'contour-lines',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': 'rgba(240, 247, 255, 0.62)',
          'line-width': 0.8,
        },
      })
      map.addLayer({
        id: 'contour-emphasis',
        type: 'line',
        source: 'contour-lines',
        filter: ['==', ['get', 'emphasis'], true],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': 'rgba(255, 210, 63, 0.95)',
          'line-width': 1.7,
        },
      })

      setMapReady(true)
      // 把首屏视窗（含四界）报给 App，URL 里带 z 时也能立刻取地区块
      emitView()
      // 首屏如果是球面视图，星空要立刻画上，不用等用户拖动
      drawStarfield(
        starCanvasRef.current,
        map,
        map.getZoom() < PROJECTION_SWITCH_ZOOM,
      )
    }
    map.on('load', onLoad)
    map.on('moveend', syncProjectionMode)
    map.on('zoomend', syncProjectionMode)

    // 用户自己缩放跨过阈值时，瞬间跳一档 zoom，制造球面/平面之间的视野落差。
    // 用上一帧的 zoom 判断跨越方向，比维护一个“当前是否平面”的状态更稳。
    let lastZoom = map.getZoom()
    let jumping = false
    const applyProjectionZoomGap = () => {
      const zoom = map.getZoom()
      const previous = lastZoom
      lastZoom = zoom
      if (jumping) return
      if (previous < PROJECTION_SWITCH_ZOOM && zoom >= PROJECTION_SWITCH_ZOOM) {
        jumping = true
        map.jumpTo({ zoom: zoom + PROJECTION_ZOOM_GAP })
        lastZoom = map.getZoom()
        jumping = false
      } else if (
        previous >= PROJECTION_SWITCH_ZOOM &&
        zoom < PROJECTION_SWITCH_ZOOM
      ) {
        jumping = true
        map.jumpTo({ zoom: Math.max(MIN_ZOOM, zoom - PROJECTION_ZOOM_GAP) })
        lastZoom = map.getZoom()
        jumping = false
      }
    }
    map.on('zoom', applyProjectionZoomGap)

    const observer = new ResizeObserver(() => {
      map.resize()
      scheduleRef.current?.()
    })
    observer.observe(container)

    const emitView = () => {
      // 球面拖拽期间不把每一帧都回灌给 React，松手时统一报一次
      if (globeDragging) return
      const center = map.getCenter()
      const bounds = map.getBounds()
      onViewChangeRef.current?.({
        lon: Number(toMapLon(center.lng).toFixed(3)),
        lat: Number(center.lat.toFixed(3)),
        zoom: Number(map.getZoom().toFixed(2)),
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      })
    }
    map.on('moveend', emitView)

    // 风羽/地名/等值线标注画在 canvas 上，地图一动就要重投影
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        drawOverlays()
      })
    }
    scheduleRef.current = schedule
    map.on('move', schedule)
    map.on('resize', schedule)

    const onMove = (event) => {
      const { x, y } = event.point
      if (lineHRef.current) lineHRef.current.style.transform = `translateY(${y}px)`
      if (lineVRef.current) lineVRef.current.style.transform = `translateX(${x}px)`
      if (dotRef.current) dotRef.current.style.transform = `translate(${x}px, ${y}px)`
      if (readoutRef.current) {
        let currentVariable = variableRef.current
        const currentDetail = detailRef.current
        const currentOcean = oceanFieldRef.current
        const currentOceanVariable = oceanVariableRef.current
        let source
        // 海面上读海温，陆地上读主填色（海洋与地面产品）
        if (
          currentOcean &&
          currentOceanVariable &&
          currentOcean.var === currentOceanVariable.id &&
          !isLand(event.lngLat.lat, event.lngLat.lng)
        ) {
          source = currentOcean
          currentVariable = currentOceanVariable
        } else {
          // 有地区块且点落在块内时读原始分辨率，否则读全球抽稀场
          source =
            currentDetail &&
            currentDetail.var === currentVariable?.id &&
            fieldContains(currentDetail, event.lngLat.lat, event.lngLat.lng)
              ? currentDetail
              : fieldRef.current
        }
        const value = source
          ? sampleFieldValue(source, event.lngLat.lat, event.lngLat.lng)
          : null
        readoutRef.current.innerHTML =
          `<span class="readout-coord">${formatLat(event.lngLat.lat)} ${formatLon(event.lngLat.lng)}</span>` +
          `<span class="readout-value">${formatValue(value, currentVariable)}</span>`
        readoutRef.current.classList.add('is-active')
      }
    }

    const onLeave = () => {
      if (readoutRef.current) readoutRef.current.classList.remove('is-active')
      for (const ref of [lineHRef, lineVRef, dotRef]) {
        if (ref.current) ref.current.style.opacity = '0'
      }
    }

    const onEnter = () => {
      for (const ref of [lineHRef, lineVRef, dotRef]) {
        if (ref.current) ref.current.style.opacity = '1'
      }
    }

    map.on('mousemove', onMove)
    map.on('mouseout', onLeave)
    map.on('mouseover', onEnter)

    // 点一下地图 = 选格点；拖动结束后的那次 click 要吞掉
    const onMapClick = (event) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      if (!onPickRef.current) return
      onPickRef.current({
        lat: Number(event.lngLat.lat.toFixed(3)),
        lon: Number(wrapLon(event.lngLat.lng).toFixed(3)),
      })
    }
    map.on('click', onMapClick)

    // ── 球面段自定义拖拽 ──
    const activePointers = new Set()

    const degreesPerPixel = () => {
      const center = map.getCenter()
      const p0 = map.project([center.lng, center.lat])
      const p1 = map.project([center.lng + 1, center.lat])
      const px = Math.abs(p1.x - p0.x)
      if (!(px > 0.001)) return { lng: 0, lat: 0 }
      // 球面投影里 1° 经线在屏幕上的宽度随纬度收缩，先还原成赤道尺度；
      // 高纬再按 MapLibre 的惯例最多加速到 2 倍，免得贴着极点时一碰就转半圈。
      const cosLat = Math.min(Math.abs(center.lat), 85) * (Math.PI / 180)
      const perPixel = Math.max(Math.cos(cosLat), 0.05) / px
      const speed =
        1 /
        Math.max(
          Math.cos(Math.min(Math.abs(center.lat), 60) * (Math.PI / 180)),
          0.5,
        )
      return { lng: perPixel * speed, lat: perPixel }
    }

    const flushGlobePan = () => {
      panFrame = 0
      if (!globeDrag || !panPending) return
      if (map.getZoom() >= PROJECTION_SWITCH_ZOOM) return
      const { dx, dy } = panPending
      panPending = null
      if (!dx && !dy) return
      const dpp = degreesPerPixel()
      const center = map.getCenter()
      const nextLng = center.lng - dx * dpp.lng
      const nextLat = clamp(center.lat + dy * dpp.lat, -85, 85)
      // 和 MapLibre 原生球面拖拽一样，中心纬度变化时同步补 zoom：
      // 球体的屏幕半径是 worldSize/(2π·cos(lat))，不补 zoom 的话
      // 往高纬拖会越拖越大，看起来像在放大。
      const radiusScale = (lat) =>
        Math.cos((Math.min(Math.abs(lat), MAX_LAT) * Math.PI) / 180)
      map.jumpTo({
        center: [nextLng, nextLat],
        zoom:
          map.getZoom() +
          Math.log2(radiusScale(nextLat) / radiusScale(center.lat)),
      })
    }

    const onGlobePointerDown = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (event.target?.closest?.('.maplibregl-ctrl')) return
      if (map.getZoom() >= PROJECTION_SWITCH_ZOOM) return
      activePointers.add(event.pointerId)
      if (activePointers.size > 1) {
        // 第二根手指落下：让 MapLibre 自己处理双指缩放
        globeDrag = null
        panPending = null
        globeDragging = false
        container.classList.remove('is-dragging')
        return
      }
      globeDrag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      }
      globeDragging = true
      container.classList.add('is-dragging')
    }

    const onGlobePointerMove = (event) => {
      if (!globeDrag || event.pointerId !== globeDrag.id) return
      if (map.getZoom() >= PROJECTION_SWITCH_ZOOM) return
      const dx = event.clientX - globeDrag.x
      const dy = event.clientY - globeDrag.y
      if (!dx && !dy) return
      globeDrag.x = event.clientX
      globeDrag.y = event.clientY
      if (
        !globeDrag.moved &&
        Math.abs(event.clientX - globeDrag.startX) +
          Math.abs(event.clientY - globeDrag.startY) >
          4
      ) {
        globeDrag.moved = true
      }
      if (panPending) {
        panPending.dx += dx
        panPending.dy += dy
      } else {
        panPending = { dx, dy }
      }
      if (!panFrame) panFrame = requestAnimationFrame(flushGlobePan)
    }

    const finishGlobeDrag = (event) => {
      activePointers.delete(event.pointerId)
      if (!globeDrag || event.pointerId !== globeDrag.id) return
      const moved = globeDrag.moved
      if (panFrame) {
        cancelAnimationFrame(panFrame)
        panFrame = 0
        flushGlobePan()
      }
      panPending = null
      globeDrag = null
      globeDragging = false
      container.classList.remove('is-dragging')
      if (moved) {
        suppressClickRef.current = true
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 350)
        emitView()
      }
    }

    // pointerdown 落在 canvas 上；move/up 挂 window，拖出地图再松手也能收尾。
    // 不用 setPointerCapture：它会把后续 click 的目标改到外层容器，
    // MapLibre 的 click（挂在 canvas 容器上）就收不到了。
    container.addEventListener('pointerdown', onGlobePointerDown)
    window.addEventListener('pointermove', onGlobePointerMove)
    window.addEventListener('pointerup', finishGlobeDrag)
    window.addEventListener('pointercancel', finishGlobeDrag)

    return () => {
      observer.disconnect()
      scheduleRef.current = null
      if (frame) cancelAnimationFrame(frame)
      if (panFrame) cancelAnimationFrame(panFrame)
      container.removeEventListener('pointerdown', onGlobePointerDown)
      window.removeEventListener('pointermove', onGlobePointerMove)
      window.removeEventListener('pointerup', finishGlobeDrag)
      window.removeEventListener('pointercancel', finishGlobeDrag)
      map.off('click', onMapClick)
      map.off('moveend', emitView)
      map.off('moveend', syncProjectionMode)
      map.off('zoomend', syncProjectionMode)
      map.off('zoom', applyProjectionZoomGap)
      map.off('move', schedule)
      map.off('resize', schedule)
      map.off('mousemove', onMove)
      map.off('mouseout', onLeave)
      map.off('mouseover', onEnter)
      markerRef.current = null
      map.remove()
      mapRef.current = null
      setMapReady(false)
    }
  }, [drawOverlays])

  // 风羽/标注的数据或开关变了，立刻重画（不用等地图移动）
  useEffect(() => {
    scheduleRef.current?.()
  }, [windField, contours, showContours, showBarbs, showPlaces, mapReady])

  // ── 点选标记 ──
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!pick) {
      markerRef.current?.remove()
      markerRef.current = null
      return
    }
    const lngLat = [wrapLon(pick.lon), clamp(pick.lat, -85, 85)]
    if (!markerRef.current) {
      const element = document.createElement('div')
      element.className = 'pick-marker'
      markerRef.current = new Marker({ element, anchor: 'center' })
        .setLngLat(lngLat)
        .addTo(map)
    } else {
      markerRef.current.setLngLat(lngLat)
    }
  }, [pick, mapReady])

  // ── 等值线数据 → GeoJSON source ──
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const source = map.getSource('contour-lines')
    if (!source) return
    source.setData(contours.lines)
    const visible = showContours && contours.lines.features.length > 0
    const visibility = visible ? 'visible' : 'none'
    map.setLayoutProperty('contour-base', 'visibility', visibility)
    map.setLayoutProperty('contour-emphasis', 'visibility', visibility)
  }, [contours, showContours, mapReady])

  // ── 全球场图 → 后端 Mercator WebP → MapLibre image source ──
  // 填色由后端按 /api/image 出图（缓存一年），前端只负责贴到 ±85.05° 的世界范围；
  // 等值线、风羽、读数和极冠仍然吃 JSON 场。
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!field || !variable || field.var !== variable.id) return

    const source = map.getSource('field')
    if (!source) return
    try {
      // 分级色标用最近邻，保留业务分级边界；连续色带用线性插值
      const resampling =
        createColormap(variable, palettes).kind === 'classes'
          ? 'nearest'
          : 'linear'
      map.setPaintProperty('field-layer', 'raster-resampling', resampling)
      const capSource = map.getSource('polar-cap')
      // 海洋与地面产品：主填色（地面气压）只铺陆地，海面留给海温层
      const landOnly = Boolean(oceanVariable)
      if (showFill) {
        source.updateImage({
          url: fieldImageUrl(field, { mask: landOnly ? 'land' : null }),
          coordinates: WORLD_COORDS,
        })
        if (capSource) {
          capSource.setData(
            polarCapData(
              field,
              variable,
              landOnly,
              palettes,
              landOnly ? oceanField : null,
              landOnly ? oceanVariable : null,
            ),
          )
        }
      } else if (capSource) {
        capSource.setData(polarCapData(null, null))
      }
      map.setLayoutProperty(
        'field-layer',
        'visibility',
        showFill ? 'visible' : 'none',
      )
    } catch (error) {
      /* 绘制失败时保留上一帧；请求错误由 App 统一提示 */
    }
  }, [
    field,
    variable,
    oceanField,
    oceanVariable,
    showFill,
    mapReady,
    maskReady,
    palettes,
  ])

  // ── 放大后的地区块 ──
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const source = map.getSource('field-detail')
    if (!source) return

    const geometry =
      detailField && variable && detailField.var === variable.id && showFill
        ? detailGeometry(detailField)
        : null
    const box = detailField ? detailBox(detailField) : null
    if (!geometry || !box) {
      map.setLayoutProperty('field-detail-layer', 'visibility', 'none')
      return
    }
    try {
      const resampling =
        createColormap(variable, palettes).kind === 'classes'
          ? 'nearest'
          : 'linear'
      map.setPaintProperty('field-detail-layer', 'raster-resampling', resampling)
      source.updateImage({
        url: fieldImageUrl(detailField, {
          bbox: box,
          mask: oceanVariable ? 'land' : null,
        }),
        coordinates: geometry.coords,
      })
      map.setLayoutProperty('field-detail-layer', 'visibility', 'visible')
      if (detailField.lead_hours !== field?.lead_hours) {
        map.setLayoutProperty('field-detail-layer', 'visibility', 'none')
      }
    } catch (error) {
      map.setLayoutProperty('field-detail-layer', 'visibility', 'none')
    }
  }, [
    detailField,
    variable,
    field,
    oceanVariable,
    showFill,
    mapReady,
    maskReady,
    palettes,
  ])

  // ── 海温叠加层（海洋与地面产品） ──
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const source = map.getSource('ocean-field')
    if (!source) return
    const usable =
      showFill &&
      oceanField &&
      oceanVariable &&
      oceanField.var === oceanVariable.id
    if (!usable) {
      map.setLayoutProperty('ocean-field-layer', 'visibility', 'none')
      return
    }
    try {
      const resampling =
        createColormap(oceanVariable, palettes).kind === 'classes'
          ? 'nearest'
          : 'linear'
      map.setPaintProperty('ocean-field-layer', 'raster-resampling', resampling)
      source.updateImage({
        url: fieldImageUrl(oceanField, { mask: 'ocean' }),
        coordinates: WORLD_COORDS,
      })
      map.setLayoutProperty('ocean-field-layer', 'visibility', 'visible')
    } catch (error) {
      map.setLayoutProperty('ocean-field-layer', 'visibility', 'none')
    }
  }, [oceanField, oceanVariable, showFill, mapReady, maskReady, palettes])

  // 没有可用场（或场还是上一个变量）时把图层藏起来，别让旧场冒充当前变量
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!field || field.var !== variable?.id) {
      map.setLayoutProperty('field-layer', 'visibility', 'none')
      const capSource = map.getSource('polar-cap')
      if (capSource) capSource.setData(polarCapData(null, null))
    }
    if (!detailField || detailField.var !== variable?.id) {
      map.setLayoutProperty('field-detail-layer', 'visibility', 'none')
    }
  }, [field, detailField, variable, mapReady])

  return (
    <div className="map-shell">
      <canvas className="star-canvas" ref={starCanvasRef} aria-hidden="true" />
      <div className="map" ref={containerRef} />

      <canvas className="overlay-canvas barbs-canvas" ref={barbsCanvasRef} />
      <canvas
        className="overlay-canvas annotation-canvas"
        ref={annotationCanvasRef}
      />

      <div className="crosshair crosshair-h" ref={lineHRef} />
      <div className="crosshair crosshair-v" ref={lineVRef} />
      <div className="crosshair-dot" ref={dotRef} />

      <div className="map-readout" ref={readoutRef}>
        <span className="readout-coord">移到图上读取数值</span>
      </div>

      {loading ? <div className="map-loading">加载场数据…</div> : null}
      {!field && !loading ? <div className="map-empty">暂无场数据</div> : null}
    </div>
  )
}
