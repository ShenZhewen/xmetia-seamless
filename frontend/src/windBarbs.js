// 风羽（wind barbs）：在 canvas 叠加层上按地图投影画，随地图平移/缩放重绘。
// 风羽按国际惯例用节（kt）表示：短划 5kt、长划 10kt、三角 50kt。
import { LngLat } from 'maplibre-gl'

const KT_PER_MS = 1.943844

// 球面投影下 map.project 会把地球背面的点也投到屏幕，必须单独剔除。
function isOccluded(map, lon, lat) {
  const transform = map.transform
  if (!transform || typeof transform.isLocationOccluded !== 'function') return false
  // z≥3 已切成平面（没有背面），跳过检查；只有球面段需要逐点判断。
  if (map.getZoom() >= 3) return false
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

function drawShaft(ctx, x, y, dx, dy, length) {
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + dx * length, y + dy * length)
  ctx.stroke()
}

function drawBarb(ctx, x, y, u, v, speed, lat, length) {
  const kt = speed * KT_PER_MS
  if (kt < 2.5) {
    ctx.beginPath()
    ctx.arc(x, y, 1.8, 0, Math.PI * 2)
    ctx.fill()
    return
  }

  // u 向东、v 向北；风羽杆指向“风从哪里来”，屏幕坐标 y 向下
  let dx = -u
  let dy = v
  const norm = Math.hypot(dx, dy) || 1
  dx /= norm
  dy /= norm
  const side = lat >= 0 ? 1 : -1
  const px = -dy * side
  const py = dx * side

  drawShaft(ctx, x, y, dx, dy, length)

  const rounded = Math.max(5, Math.round(kt / 5) * 5)
  let tens = Math.floor(rounded / 10)
  let fifties = Math.floor(tens / 5)
  tens -= fifties * 5
  let fives = rounded % 10 >= 5 ? 1 : 0

  let cursor = length
  const step = 5.2
  const feather = 8

  while (fifties > 0) {
    const bx = x + dx * cursor
    const by = y + dy * cursor
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.lineTo(bx - dx * 4 + px * feather, by - dy * 4 + py * feather)
    ctx.lineTo(bx - dx * 4, by - dy * 4)
    ctx.closePath()
    ctx.fill()
    cursor -= step
    fifties -= 1
  }
  while (tens > 0) {
    const bx = x + dx * cursor
    const by = y + dy * cursor
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.lineTo(bx + px * feather, by + py * feather)
    ctx.stroke()
    cursor -= step
    tens -= 1
  }
  if (fives > 0) {
    const bx = x + dx * cursor
    const by = y + dy * cursor
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.lineTo(bx + px * feather * 0.62, by + py * feather * 0.62)
    ctx.stroke()
  }
}

export function drawWindBarbs(canvas, map, field, { visible = true } = {}) {
  if (!canvas) return
  const { ctx, width, height } = fitCanvas(canvas)
  if (!visible || !map || !field?.u || !field?.v) return

  const lats = field.lat
  const lons = field.lon
  const uRows = field.u
  const vRows = field.v
  const ny = uRows.length
  const nx = uRows[0]?.length ?? 0
  if (ny < 2 || nx < 2) return

  const zoom = map.getZoom()
  let step = zoom < 2 ? 16 : zoom < 3.5 ? 8 : zoom < 4.8 ? 4 : zoom < 6 ? 2 : 1
  // 屏幕上的风羽密度由像素哈希控制；这里再给循环次数一个上限
  while ((nx / step) * (ny / step) > 14000 && step < 32) step += 1

  const occupied = new Set()
  const hashCell = 46
  const length = zoom > 6 ? 26 : 30
  const halo = 'rgba(3, 8, 16, 0.85)'
  const ink = 'rgba(232, 244, 255, 0.95)'

  for (let j = 0; j < ny; j += step) {
    const uRow = uRows[j]
    const vRow = vRows[j]
    for (let i = 0; i < nx; i += step) {
      const u = uRow?.[i]
      const v = vRow?.[i]
      if (u == null || v == null) continue
      const lat = lats[j]
      const lon = wrapLon(lons[i])
      if (isOccluded(map, lon, lat)) continue
      const point = map.project([lon, lat])
      if (point.x < -30 || point.x > width + 30 || point.y < -30 || point.y > height + 30) {
        continue
      }
      const cell = `${Math.floor(point.x / hashCell)},${Math.floor(point.y / hashCell)}`
      if (occupied.has(cell)) continue
      occupied.add(cell)

      const speed = Math.hypot(u, v)
      ctx.strokeStyle = halo
      ctx.fillStyle = halo
      ctx.lineWidth = 3
      drawBarb(ctx, point.x, point.y, u, v, speed, lat, length)
      ctx.strokeStyle = ink
      ctx.fillStyle = ink
      ctx.lineWidth = 1.15
      drawBarb(ctx, point.x, point.y, u, v, speed, lat, length)
    }
  }
}
