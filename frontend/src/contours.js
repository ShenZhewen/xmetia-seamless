// 客户端等值线：marching squares + 线段串联。
// 输入是后端抽稀后的经纬网格，输出 GeoJSON 线 + 供 canvas 标注用的 label 点。
import { formatTick, toRaw } from './colormap.js'

const EPS = 1e-9

function wrapLon(lon) {
  const wrapped = ((lon % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

function interp(va, vb, pa, pb, level) {
  if (Math.abs(vb - va) < EPS) return (pa + pb) / 2
  return pa + ((pb - pa) * (level - va)) / (vb - va)
}

// 等值线穿过格子边时，返回 [lon, lat]
function edgePoint(edge, level, a, b, c, d, lat0, lat1, lon0, lon1) {
  if (edge === 'top') {
    return [interp(a, b, lon0, lon1, level), lat0]
  }
  if (edge === 'right') {
    return [lon1, interp(b, c, lat0, lat1, level)]
  }
  if (edge === 'bottom') {
    return [interp(d, c, lon0, lon1, level), lat1]
  }
  return [lon0, interp(a, d, lat0, lat1, level)]
}

function segmentsForCase(caseIndex, level, a, b, c, d, lat0, lat1, lon0, lon1) {
  const t = () => edgePoint('top', level, a, b, c, d, lat0, lat1, lon0, lon1)
  const r = () => edgePoint('right', level, a, b, c, d, lat0, lat1, lon0, lon1)
  const bt = () => edgePoint('bottom', level, a, b, c, d, lat0, lat1, lon0, lon1)
  const l = () => edgePoint('left', level, a, b, c, d, lat0, lat1, lon0, lon1)

  switch (caseIndex) {
    case 1:
    case 14:
      return [[l(), t()]]
    case 2:
    case 13:
      return [[t(), r()]]
    case 3:
    case 12:
      return [[l(), r()]]
    case 4:
    case 11:
      return [[r(), bt()]]
    case 6:
    case 9:
      return [[t(), bt()]]
    case 7:
    case 8:
      return [[l(), bt()]]
    case 5: {
      const center = (a + b + c + d) / 4
      return center > level
        ? [[t(), r()], [l(), bt()]]
        : [[l(), t()], [r(), bt()]]
    }
    case 10: {
      const center = (a + b + c + d) / 4
      return center > level
        ? [[l(), t()], [r(), bt()]]
        : [[t(), r()], [l(), bt()]]
    }
    default:
      return []
  }
}

function keyOf(point) {
  return `${point[0].toFixed(4)},${point[1].toFixed(4)}`
}

// 把散线段按端点串成折线，减少 MapLibre 的 feature 数和断头线。
function chainSegments(segments) {
  if (!segments.length) return []
  const endpoints = new Map()
  segments.forEach((segment, index) => {
    for (const point of segment) {
      const key = keyOf(point)
      const list = endpoints.get(key)
      if (list) list.push(index)
      else endpoints.set(key, [index])
    }
  })

  const used = new Uint8Array(segments.length)
  const lines = []

  const otherEnd = (index, key) =>
    keyOf(segments[index][0]) === key ? segments[index][1] : segments[index][0]

  const extend = (key, line, append) => {
    let cursor = key
    for (let guard = 0; guard <= segments.length; guard += 1) {
      const candidates = endpoints.get(cursor) ?? []
      const index = candidates.find((candidate) => !used[candidate])
      if (index == null) break
      used[index] = 1
      const next = otherEnd(index, cursor)
      if (append) line.push(next)
      else line.unshift(next)
      cursor = keyOf(next)
    }
  }

  for (let index = 0; index < segments.length; index += 1) {
    if (used[index]) continue
    used[index] = 1
    const line = [segments[index][0], segments[index][1]]
    extend(keyOf(segments[index][1]), line, true)
    extend(keyOf(segments[index][0]), line, false)
    if (line.length >= 2) lines.push(line)
  }
  return lines
}

/**
 * @param {object} field 后端场：lat/lon/values
 * @param {number[]} levelsDisplay 显示单位下的等值线层级
 * @param {object} variable 变量元数据（scale/offset/contour_emphasis）
 */
export function buildContours(field, levelsDisplay, variable) {
  const empty = {
    lines: { type: 'FeatureCollection', features: [] },
    labels: [],
  }
  if (!field?.values?.length || !levelsDisplay?.length) return empty

  const lats = field.lat
  const lons = field.lon
  const values = field.values
  const ny = values.length
  const nx = values[0]?.length ?? 0
  if (ny < 2 || nx < 2) return empty

  const rawLevels = levelsDisplay.map((level) => ({
    display: level,
    raw: toRaw(level, variable),
    emphasis:
      variable.contour_emphasis != null &&
      Math.abs(level - variable.contour_emphasis) < 1e-6,
    label: formatTick(level),
  }))
  rawLevels.sort((a, b) => a.raw - b.raw)

  const segmentsByLevel = new Map(rawLevels.map((level) => [level.raw, []]))
  const midpointsByLevel = new Map(rawLevels.map((level) => [level.raw, []]))

  for (let j = 0; j < ny - 1; j += 1) {
    const lat0 = lats[j]
    const lat1 = lats[j + 1]
    const row0 = values[j]
    const row1 = values[j + 1]
    if (!row0 || !row1) continue

    for (let i = 0; i < nx - 1; i += 1) {
      const a = row0[i]
      const b = row0[i + 1]
      const c = row1[i + 1]
      const d = row1[i]
      if (a == null || b == null || c == null || d == null) continue

      const min = Math.min(a, b, c, d)
      const max = Math.max(a, b, c, d)
      const lon0 = lons[i]
      const lon1 = lons[i + 1]

      for (const level of rawLevels) {
        if (level.raw < min || level.raw > max) continue
        const caseIndex =
          (a > level.raw ? 1 : 0) |
          (b > level.raw ? 2 : 0) |
          (c > level.raw ? 4 : 0) |
          (d > level.raw ? 8 : 0)
        const pieces = segmentsForCase(
          caseIndex, level.raw, a, b, c, d, lat0, lat1, lon0, lon1,
        )
        const segments = segmentsByLevel.get(level.raw)
        const midpoints = midpointsByLevel.get(level.raw)
        for (const [p0, p1] of pieces) {
          // 内层经度先包到 -180..180；跨日界线的线段直接丢掉，避免横穿整张图
          const q0 = [wrapLon(p0[0]), p0[1]]
          const q1 = [wrapLon(p1[0]), p1[1]]
          if (Math.abs(q0[0] - q1[0]) > 180) continue
          segments.push([q0, q1])
          midpoints.push([
            (q0[0] + q1[0]) / 2,
            (q0[1] + q1[1]) / 2,
          ])
        }
      }
    }
  }

  const features = []
  const labels = []
  const labelGrid = new Set()
  const labelCell = 4 // 度；4° 一个标注格子，避免密密麻麻

  for (const level of rawLevels) {
    const segments = segmentsByLevel.get(level.raw) ?? []
    const lines = chainSegments(segments)
    for (const coords of lines) {
      if (coords.length < 2) continue
      features.push({
        type: 'Feature',
        properties: {
          level: level.display,
          label: level.label,
          emphasis: level.emphasis,
        },
        geometry: {
          type: 'LineString',
          coordinates: coords.map(([lon, lat]) => [
            Math.round(lon * 1000) / 1000,
            Math.round(lat * 1000) / 1000,
          ]),
        },
      })
    }

    const midpoints = midpointsByLevel.get(level.raw) ?? []
    for (let index = 0; index < midpoints.length; index += 3) {
      if (labels.length >= 180) break
      const [lon, lat] = midpoints[index]
      const cell = `${level.raw}|${Math.floor((lon + 180) / labelCell)}|${Math.floor((lat + 90) / labelCell)}`
      if (labelGrid.has(cell)) continue
      labelGrid.add(cell)
      labels.push({
        lon,
        lat,
        text: level.label,
        emphasis: level.emphasis,
      })
    }
  }

  return {
    lines: { type: 'FeatureCollection', features },
    labels,
  }
}
