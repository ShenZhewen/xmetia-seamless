// 把等经纬网格场重采样成 Web Mercator 图片，交给 MapLibre 的 image source。
// 不传 bounds 是整幅全球图（±180°、±85.0511°）；传 bounds 只渲染视窗附近的一块，
// 放大后从后端按 bbox 取原始分辨率，再贴到对应的经纬度范围上。
import { createColormap, toDisplay } from './colormap.js'

const MAX_LAT = 85.05112878
const SIZE = 1152
const MAX_PART_SIZE = 1024

function mercatorY(lat) {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))
}

function latFromMercatorY(y) {
  return (Math.atan(Math.sinh(y)) * 180) / Math.PI
}

function axisStep(axis) {
  return axis.length > 1 ? (axis[axis.length - 1] - axis[0]) / (axis.length - 1) : 1
}

// 全球场的经度列覆盖 360°，读数/采样时要环绕；地区块直接钳到边界。
function wrapPeriodOf(axis) {
  if (axis.length > 1 && Math.abs(axisStep(axis)) * axis.length > 359) return 360
  return null
}

function fractionFor(axis, value, wrap) {
  const n = axis.length
  const step = axisStep(axis)
  if (!step) return 0
  if (wrap) {
    const rel = (((value - axis[0]) % wrap) + wrap) % wrap
    let fraction = rel / step
    if (fraction >= n) fraction -= n
    return fraction
  }
  return Math.min(n - 1, Math.max(0, (value - axis[0]) / step))
}

function makeIndices(axis, targets, wrap) {
  const n = axis.length
  const i0 = new Int32Array(targets.length)
  const i1 = new Int32Array(targets.length)
  const weight = new Float32Array(targets.length)
  for (let k = 0; k < targets.length; k += 1) {
    const fraction = fractionFor(axis, targets[k], wrap)
    const a = Math.floor(fraction)
    i0[k] = a
    i1[k] = wrap ? (a + 1) % n : Math.min(a + 1, n - 1)
    weight[k] = fraction - a
  }
  return { i0, i1, weight }
}

function clampSize(value) {
  return Math.max(96, Math.min(MAX_PART_SIZE, value))
}

function regionBox(bounds) {
  const west = Math.max(-180, bounds.west)
  const east = Math.min(180, bounds.east)
  const south = Math.max(-MAX_LAT, bounds.south)
  const north = Math.min(MAX_LAT, bounds.north)
  const y0 = mercatorY(south)
  const y1 = mercatorY(north)
  if (!(east > west) || !(y1 > y0)) return null

  // 输出图的像素宽高比要跟地图上的 Mercator 宽高比一致，贴上去才不变形。
  const ratio = (east - west) / 360 / ((y1 - y0) / (2 * Math.PI))
  let width
  let height
  if (ratio >= 1) {
    width = MAX_PART_SIZE
    height = clampSize(Math.round(MAX_PART_SIZE / ratio))
  } else {
    height = MAX_PART_SIZE
    width = clampSize(Math.round(MAX_PART_SIZE * ratio))
  }
  return { west, east, south, north, width, height, y0, y1 }
}

// keep(lat, lon)：可选掩膜，返回 false 的像素保持透明。
export function renderFieldImage(field, variable, bounds = null, keep = null) {
  const values = field.values
  const ny = values.length
  const nx = values[0]?.length ?? 0
  if (!ny || !nx) return new ImageData(1, 1)

  const latAxis = field.lat
  const lonAxis = field.lon
  const latWrap = wrapPeriodOf(latAxis)
  const lonWrap = wrapPeriodOf(lonAxis)

  let width = SIZE
  let height = SIZE
  let west = -180
  let east = 180
  let south = -MAX_LAT
  let north = MAX_LAT
  let y0 = mercatorY(-MAX_LAT)
  let y1 = mercatorY(MAX_LAT)

  if (bounds) {
    const box = regionBox(bounds)
    if (!box) return new ImageData(1, 1)
    ;({ west, east, south, north, width, height, y0, y1 } = box)
  }

  const lonTargets = new Float64Array(width)
  for (let x = 0; x < width; x += 1) {
    lonTargets[x] = west + ((x + 0.5) / width) * (east - west)
  }
  // ImageData 第 0 行是图片顶边（北），而 y0/y1 是 Mercator 的南/北边界，
  // 所以第 0 行要从 y1 往 y0 走；反过来画整张图会上下镜像。
  const latTargets = new Float64Array(height)
  for (let y = 0; y < height; y += 1) {
    const merc = y1 - ((y + 0.5) / height) * (y1 - y0)
    latTargets[y] = latFromMercatorY(merc)
  }

  const cols = makeIndices(lonAxis, lonTargets, lonWrap)
  const rows = makeIndices(latAxis, latTargets, latWrap)

  const cmap = createColormap(variable)
  const image = new ImageData(width, height)
  const out = image.data

  for (let y = 0; y < height; y += 1) {
    const j0 = rows.i0[y]
    const j1 = rows.i1[y]
    const wy = rows.weight[y]
    const row0 = values[j0]
    const row1 = values[j1]

    for (let x = 0; x < width; x += 1) {
      if (keep && !keep(latTargets[y], lonTargets[x])) continue
      if (!row0 || !row1) continue
      const i0 = cols.i0[x]
      const i1 = cols.i1[x]
      const wx = cols.weight[x]
      const a = row0[i0]
      const b = row0[i1]
      const c = row1[i0]
      const d = row1[i1]

      let value
      if (a == null || b == null || c == null || d == null) {
        value = a ?? b ?? c ?? d
      } else {
        const top = a + (b - a) * wx
        const bottom = c + (d - c) * wx
        value = top + (bottom - top) * wy
      }

      const offset = (y * width + x) * 4
      if (value == null) {
        out[offset + 3] = 0
        continue
      }
      const rgba = cmap.rgba(toDisplay(value, variable))
      if (!rgba) {
        out[offset + 3] = 0
        continue
      }
      out[offset] = rgba[0]
      out[offset + 1] = rgba[1]
      out[offset + 2] = rgba[2]
      out[offset + 3] = rgba[3]
    }
  }

  return image
}

// 极冠取色用：双线性插值，和贴图自己在边缘的重采样一致，接缝才不会跳色。
export function sampleFieldValueSmooth(field, lat, lon) {
  const values = field.values
  const ny = values.length
  const nx = values[0]?.length ?? 0
  if (!ny || !nx) return null
  const latWrap = wrapPeriodOf(field.lat)
  const lonWrap = wrapPeriodOf(field.lon)
  const fy = fractionFor(field.lat, lat, latWrap)
  const fx = fractionFor(field.lon, lon, lonWrap)
  const j0 = Math.floor(fy)
  const i0 = Math.floor(fx)
  const wy = fy - j0
  const wx = fx - i0
  const j1 = latWrap ? (j0 + 1) % ny : Math.min(j0 + 1, ny - 1)
  const i1 = lonWrap ? (i0 + 1) % nx : Math.min(i0 + 1, nx - 1)
  const a = values[j0]?.[i0]
  const b = values[j0]?.[i1]
  const c = values[j1]?.[i0]
  const d = values[j1]?.[i1]
  let value
  if (a == null || b == null || c == null || d == null) {
    value = a ?? b ?? c ?? d
  } else {
    const top = a + (b - a) * wx
    const bottom = c + (d - c) * wx
    value = top + (bottom - top) * wy
  }
  return value == null ? null : value
}

// 鼠标读值：取最近的原始格点，不插值，避免把数值读“漂亮”了。
export function sampleFieldValue(field, lat, lon) {
  const values = field.values
  const ny = values.length
  const nx = values[0].length
  const latWrap = wrapPeriodOf(field.lat)
  const lonWrap = wrapPeriodOf(field.lon)
  let j = Math.round(fractionFor(field.lat, lat, latWrap))
  let i = Math.round(fractionFor(field.lon, lon, lonWrap))
  j = ((j % ny) + ny) % ny
  i = ((i % nx) + nx) % nx
  const value = values[j]?.[i]
  return value == null ? null : value
}

// 点是否落在这一块场的范围内（地区块用；全局场恒为 true）。
export function fieldContains(field, lat, lon) {
  if (!field) return false
  const lats = field.lat
  const lons = field.lon
  const latMin = Math.min(lats[0], lats[lats.length - 1])
  const latMax = Math.max(lats[0], lats[lats.length - 1])
  if (lat < latMin || lat > latMax) return false
  if (wrapPeriodOf(lons)) return true
  const lonMin = Math.min(lons[0], lons[lons.length - 1])
  const lonMax = Math.max(lons[0], lons[lons.length - 1])
  const target = ((lon % 360) + 360) % 360
  return target >= lonMin && target <= lonMax
}

// 数据集的 lon 是 0..360，MapLibre 的贴图和坐标用 -180..180。
export function toMapLon(lon) {
  const wrapped = ((lon % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

export { MAX_LAT, SIZE }
