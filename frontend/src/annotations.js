// 叠加标注层：国名、城市名、等值线标值，统一画在一张 canvas 上。
// 全部离线（不依赖 MapLibre 的 glyph 服务），中文也能正常显示。
// 自带简单的屏幕矩形避让，避免城市名和等值线数字叠在一起。
import { LngLat } from 'maplibre-gl'
import { COUNTRIES, CITIES } from './places.js'

// 球面投影下 map.project 会把地球背面的点也投到屏幕，必须单独剔除。
// 先用球心夹角兜底：和相机中心夹角超过 90° 的点一定在地球背面。
// 新版 MapLibre 的 isLocationOccluded 个别情况下会漏判（转到西半球仍画出
// 中国的地名），两道判断取并集。
function isOnNearSide(map, lon, lat) {
  const center = map.getCenter()
  const rad = Math.PI / 180
  const lat0 = center.lat * rad
  const lat1 = lat * rad
  const dLon = (lon - center.lng) * rad
  const dot =
    Math.sin(lat0) * Math.sin(lat1) +
    Math.cos(lat0) * Math.cos(lat1) * Math.cos(dLon)
  return dot > 0
}

function isOccluded(map, lon, lat) {
  // z≥3 已切成平面（没有背面），跳过检查；只有球面段需要逐点判断。
  if (map.getZoom() >= 3) return false
  if (!isOnNearSide(map, lon, lat)) return true
  const transform = map.transform
  if (!transform || typeof transform.isLocationOccluded !== 'function') return false
  return transform.isLocationOccluded(new LngLat(lon, lat))
}

function wrapLon(lon) {
  const wrapped = ((lon % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return { ctx, width, height }
}

function overlaps(boxes, box) {
  for (const other of boxes) {
    if (
      box.x < other.x + other.w &&
      box.x + box.w > other.x &&
      box.y < other.y + other.h &&
      box.y + box.h > other.y
    ) {
      return true
    }
  }
  return false
}

// 文字带深色描边，浅底深底都看得清
function label(ctx, text, x, y, { font, color, halo, align = 'left' }) {
  ctx.font = font
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = halo
  ctx.lineWidth = 3
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

export function drawAnnotations(
  canvas,
  map,
  { contourLabels = [], showPlaces = true, showContours = true } = {},
) {
  if (!canvas) return
  const { ctx, width, height } = fitCanvas(canvas)
  if (!map) return

  const zoom = map.getZoom()
  const boxes = []
  const visible = (point, pad = 40) =>
    point.x >= -pad && point.x <= width + pad && point.y >= -pad && point.y <= height + pad

  if (showContours && contourLabels.length) {
    ctx.textAlign = 'left'
    for (const item of contourLabels) {
      const lon = wrapLon(item.lon)
      if (isOccluded(map, lon, item.lat)) continue
      const point = map.project([lon, item.lat])
      if (!visible(point)) continue
      const font = item.emphasis
        ? '600 11px "Segoe UI", "Microsoft YaHei", sans-serif'
        : '600 10.5px "Segoe UI", "Microsoft YaHei", sans-serif'
      ctx.font = font
      const textWidth = ctx.measureText(item.text).width
      const box = {
        x: point.x - textWidth / 2 - 3,
        y: point.y - 7,
        w: textWidth + 6,
        h: 14,
      }
      if (overlaps(boxes, box)) continue
      boxes.push(box)
      label(ctx, item.text, point.x, point.y, {
        font,
        color: item.emphasis ? '#f7d774' : 'rgba(240, 247, 255, 0.92)',
        halo: 'rgba(4, 9, 17, 0.9)',
        align: 'center',
      })
    }
  }

  if (!showPlaces) return

  // 大洲尺度只放国名，放大以后城市逐步出现
  if (zoom < 5.4) {
    const font = '500 11px "Segoe UI", "Microsoft YaHei", sans-serif'
    for (const [name, lon, lat] of COUNTRIES) {
      const wrapped = wrapLon(lon)
      if (isOccluded(map, wrapped, lat)) continue
      const point = map.project([wrapped, lat])
      if (!visible(point)) continue
      ctx.font = font
      const textWidth = ctx.measureText(name).width
      const box = {
        x: point.x - textWidth / 2 - 4,
        y: point.y - 8,
        w: textWidth + 8,
        h: 16,
      }
      if (overlaps(boxes, box)) continue
      boxes.push(box)
      label(ctx, name, point.x, point.y, {
        font,
        color: 'rgba(155, 176, 202, 0.6)',
        halo: 'rgba(4, 9, 17, 0.75)',
        align: 'center',
      })
    }
  }

  const cityMinZoom = zoom < 3.2 ? 1.2 : 2.2
  if (zoom >= cityMinZoom) {
    const showTier1 = zoom >= 4.2
    for (const [name, lon, lat, tier] of CITIES) {
      if (tier === 1 && !showTier1) continue
      const wrapped = wrapLon(lon)
      if (isOccluded(map, wrapped, lat)) continue
      const point = map.project([wrapped, lat])
      if (!visible(point)) continue
      const font =
        tier === 0
          ? '600 12px "Segoe UI", "Microsoft YaHei", sans-serif'
          : '500 11px "Segoe UI", "Microsoft YaHei", sans-serif'
      ctx.font = font
      const textWidth = ctx.measureText(name).width
      const box = {
        x: point.x - 4,
        y: point.y - 8,
        w: textWidth + 10,
        h: 16,
      }
      if (overlaps(boxes, box)) continue
      boxes.push(box)

      ctx.beginPath()
      ctx.fillStyle = tier === 0 ? '#e8f2ff' : 'rgba(214, 230, 248, 0.85)'
      ctx.arc(point.x, point.y, tier === 0 ? 2.2 : 1.7, 0, Math.PI * 2)
      ctx.fill()

      label(ctx, name, point.x + 6, point.y, {
        font,
        color: tier === 0 ? '#eaf3ff' : 'rgba(213, 230, 249, 0.86)',
        halo: 'rgba(4, 9, 17, 0.92)',
      })
    }
  }
}
