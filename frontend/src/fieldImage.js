// JSON 场的取样工具：鼠标读数（最近格点）、极冠取色（双线性）、地区块判界。
// 填色图本身已经改由后端 /api/image 出 WebP，这里不再做客户端重投影。
const MAX_LAT = 85.05112878

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

export { MAX_LAT }
