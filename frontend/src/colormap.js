// 业务色标。降水用中国气象局/气象部门的分级色表（离散填色），
// 温度、气压、位势高度、湿度用气象业务常用的连续色带，风分量/变化量用发散色带。
// 所有 range 都是“显示单位”下的区间；数据换算见 displayScale/displayOffset。
import { interpolateRdBu } from 'd3-scale-chromatic'

const LUT_SIZE = 256

// ── 官方降水色表 ────────────────────────────────────────────────────────
// GB/T 35968-2018（24h 降水量图形产品规范）11 级
const TP24_EDGES = [0.1, 10, 25, 50, 100, 250, 400, 600, 800, 1000]
const TP24_COLORS = [
  [161, 241, 141], // 0.1–10
  [61, 186, 61],   // 10–25
  [96, 184, 255],  // 25–50
  [0, 0, 255],     // 50–100
  [250, 0, 250],   // 100–250
  [128, 0, 64],    // 250–400
  [255, 170, 0],   // 400–600
  [255, 102, 0],   // 600–800
  [230, 0, 0],     // 800–1000
  [80, 45, 10],    // ≥1000
]

// DB4104/T 124-2023 6h 降雨量等级配色（0.1–120 mm，共 15 个有色区间）
// 最后多加一档 ≥120 的深色，地方标准表只到 120 mm，超过时用最深色兜底。
const TP6_EDGES = [
  0.1, 1.4, 2.7, 4.0, 7.7, 11.3, 15.0, 18.3,
  21.7, 25.0, 36.7, 48.3, 60.0, 80.0, 100.0, 120.0,
]
const TP6_COLORS = [
  [165, 243, 141], [130, 223, 115], [95, 204, 89], [61, 185, 63],
  [73, 184, 125], [86, 184, 187], [99, 184, 249], [66, 122, 250],
  [33, 61, 252], [0, 0, 254], [81, 1, 248], [162, 3, 243],
  [243, 5, 238], [205, 3, 180], [167, 1, 122], [120, 0, 60],
]

const scaleEdges = (edges, factor) =>
  edges.map((value) => Math.round(value * factor * 10) / 10)

// ── 其它要素色标 ────────────────────────────────────────────────────────
const PALETTES = {
  tp6: {
    type: 'classes', edges: TP6_EDGES, colors: TP6_COLORS,
    below: TP6_EDGES[0], belowLabel: '无降水',
  },
  tp24: {
    type: 'classes', edges: TP24_EDGES, colors: TP24_COLORS,
    below: TP24_EDGES[0], belowLabel: '无降水',
  },
  tp48: {
    type: 'classes', edges: scaleEdges(TP24_EDGES, 2), colors: TP24_COLORS,
    below: TP24_EDGES[0] * 2, belowLabel: '无降水',
  },
  tp72: {
    type: 'classes', edges: scaleEdges(TP24_EDGES, 3), colors: TP24_COLORS,
    below: TP24_EDGES[0] * 3, belowLabel: '无降水',
  },
  wind: {
    type: 'classes',
    edges: [0, 2, 4, 6, 8, 12, 16, 20, 25],
    colors: [
      [120, 160, 200], [100, 200, 180], [130, 220, 120],
      [220, 230, 100], [250, 200, 80], [250, 150, 60],
      [240, 90, 50], [210, 40, 40], [150, 20, 90],
    ],
  },
  temperature: {
    type: 'stops',
    stops: [
      [-40, [40, 10, 80]],
      [-30, [80, 30, 140]],
      [-20, [70, 70, 200]],
      [-10, [40, 120, 235]],
      [0, [120, 200, 240]],
      [10, [140, 225, 150]],
      [20, [255, 235, 110]],
      [30, [255, 160, 60]],
      [40, [210, 40, 40]],
      [50, [120, 0, 0]],
    ],
    tickValues: [-40, -20, 0, 20, 40],
  },
  pressure: {
    type: 'stops',
    stops: [
      [950, [30, 40, 120]],
      [980, [60, 110, 220]],
      [1000, [140, 190, 245]],
      [1010, [235, 240, 250]],
      [1013, [255, 255, 255]],
      [1020, [250, 235, 160]],
      [1030, [250, 180, 80]],
      [1040, [220, 80, 40]],
      [1060, [120, 20, 20]],
    ],
    tickValues: [950, 1000, 1013, 1030, 1050],
  },
  height: {
    type: 'stops',
    stops: [
      [480, [20, 20, 90]],
      [500, [30, 80, 180]],
      [520, [40, 150, 210]],
      [540, [80, 190, 130]],
      [560, [220, 220, 100]],
      [580, [240, 150, 60]],
      [600, [200, 50, 40]],
    ],
    tickValues: [480, 510, 540, 570, 600],
  },
  moisture: {
    type: 'stops',
    stops: [
      [0, [120, 80, 50]],
      [3, [190, 150, 105]],
      [6, [235, 220, 190]],
      [9, [180, 220, 150]],
      [12, [90, 185, 140]],
      [16, [45, 130, 200]],
      [20, [30, 70, 170]],
      [24, [45, 30, 120]],
    ],
    tickValues: [0, 5, 10, 15, 20],
  },
  component: { type: 'diverging', interpolate: interpolateRdBu, reverse: true, center: 0 },
  diff: { type: 'diverging', interpolate: interpolateRdBu, reverse: true, center: 0 },
}

const DEFAULT_PALETTE = PALETTES.temperature

const cache = new Map()

// 数据文件是物理量（K、Pa、m²/s²），图例和读数按业务单位显示。
export function displayScale(variable) {
  return variable?.scale ?? 1
}

export function displayOffset(variable) {
  return variable?.offset ?? 0
}

export function displayUnit(variable) {
  return variable?.display_unit ?? variable?.unit ?? ''
}

export function toDisplay(value, variable) {
  if (value == null) return null
  return value * displayScale(variable) + displayOffset(variable)
}

export function toRaw(value, variable) {
  if (value == null) return null
  return (value - displayOffset(variable)) / displayScale(variable)
}

function parseRgb(css) {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(css)
  if (!match) return [255, 255, 255]
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function buildLut(interpolate, reverse) {
  const lut = new Uint8ClampedArray(LUT_SIZE * 4)
  for (let i = 0; i < LUT_SIZE; i += 1) {
    const t = i / (LUT_SIZE - 1)
    const [r, g, b] = parseRgb(interpolate(reverse ? 1 - t : t))
    lut[i * 4] = r
    lut[i * 4 + 1] = g
    lut[i * 4 + 2] = b
    lut[i * 4 + 3] = 255
  }
  return lut
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function colorInStops(stops, value) {
  if (value <= stops[0][0]) return stops[0][1]
  const last = stops[stops.length - 1]
  if (value >= last[0]) return last[1]
  for (let i = 1; i < stops.length; i += 1) {
    const [hiValue, hiColor] = stops[i]
    if (value <= hiValue) {
      const [loValue, loColor] = stops[i - 1]
      const t = (value - loValue) / (hiValue - loValue || 1)
      return [
        Math.round(loColor[0] + (hiColor[0] - loColor[0]) * t),
        Math.round(loColor[1] + (hiColor[1] - loColor[1]) * t),
        Math.round(loColor[2] + (hiColor[2] - loColor[2]) * t),
      ]
    }
  }
  return last[1]
}

function classColor(edges, colors, value) {
  if (value < edges[0]) return null
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (value < edges[i + 1]) return colors[i] ?? colors[colors.length - 1]
  }
  return colors[edges.length - 1] ?? colors[colors.length - 1]
}

function classIndex(edges, value) {
  if (value < edges[0]) return -1
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (value < edges[i + 1]) return i
  }
  return edges.length - 1
}

// 图例分档：<below 单独一档（白色/透明），然后 [edges[i], edges[i+1])，
// 最后一档是 ≥edges[last]。
function buildClassRows(palette) {
  const { edges, colors } = palette
  const rows = []
  if (palette.below != null) {
    rows.push({
      label: `${palette.belowLabel ?? '低于起始值'} < ${formatTick(palette.below)}`,
      color: null,
      transparent: true,
    })
  }
  for (let i = 0; i < edges.length - 1; i += 1) {
    const from = i === 0 && palette.below != null ? palette.below : edges[i]
    rows.push({
      label: `${formatTick(from)} – ${formatTick(edges[i + 1])}`,
      color: colors[i] ?? colors[colors.length - 1],
    })
  }
  const last = edges[edges.length - 1]
  rows.push({
    label: `≥ ${formatTick(last)}`,
    color: colors[edges.length - 1] ?? colors[colors.length - 1],
  })
  return rows
}

function tickPositions(values, lo, hi) {
  return values
    .filter((value) => value >= lo && value <= hi)
    .map((value) => ({
      value,
      pos: hi === lo ? 50 : ((value - lo) / (hi - lo)) * 100,
    }))
}

export function createColormap(variable) {
  const scale = displayScale(variable)
  const offset = displayOffset(variable)
  const lo = variable.range[0]
  const hi = variable.range[1]
  const key = `${variable.palette ?? variable.id}|${lo}|${hi}|${scale}|${offset}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }

  const palette = PALETTES[variable.palette] ?? DEFAULT_PALETTE
  const center = palette.center ?? 0
  const diverging = palette.type === 'diverging' && center > lo && center < hi
  const lut = palette.type === 'diverging'
    ? buildLut(palette.interpolate, palette.reverse)
    : null

  let colorFor
  let toT
  if (palette.type === 'classes') {
    colorFor = (value) => classColor(palette.edges, palette.colors, value)
    toT = (value) => {
      const index = classIndex(palette.edges, value)
      return index < 0 ? 0 : clamp01(index / Math.max(1, palette.edges.length - 1))
    }
  } else if (palette.type === 'diverging') {
    toT = (value) => {
      if (diverging) {
        if (value <= center) return 0.5 * clamp01((value - lo) / (center - lo))
        return 0.5 + 0.5 * clamp01((value - center) / (hi - center))
      }
      return hi === lo ? 0.5 : clamp01((value - lo) / (hi - lo))
    }
    colorFor = (value) => {
      const index = Math.round(toT(value) * (LUT_SIZE - 1)) * 4
      return [lut[index], lut[index + 1], lut[index + 2]]
    }
  } else {
    colorFor = (value) => colorInStops(palette.stops, value)
    toT = (value) => (hi === lo ? 0.5 : clamp01((value - lo) / (hi - lo)))
  }

  const legendColors = []
  for (let i = 0; i <= 16; i += 1) {
    const value = lo + ((hi - lo) * i) / 16
    // 分级色标在起始阈值以下会返回 null（降水 < 0.1mm 不填色），
    // 这里必须跳过，否则解构 null 会抛错，图例一崩整页都白/黑。
    const color = colorFor(value)
    if (!color) continue
    const [r, g, b] = color
    legendColors.push(`rgb(${r}, ${g}, ${b}) ${((i / 16) * 100).toFixed(1)}%`)
  }

  let ticks
  if (palette.type === 'classes') {
    ticks = []
  } else if (palette.type === 'diverging' && diverging) {
    ticks = [
      { value: lo, pos: 0 },
      { value: center, pos: ((center - lo) / (hi - lo || 1)) * 100 },
      { value: hi, pos: 100 },
    ]
  } else if (palette.tickValues) {
    const values = [...palette.tickValues]
    const span = hi - lo
    if (values[0] > lo + span * 0.08) values.unshift(lo)
    if (values[values.length - 1] < hi - span * 0.08) values.push(hi)
    ticks = tickPositions(values, lo, hi)
  } else {
    ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
      value: lo + (hi - lo) * fraction,
      pos: fraction * 100,
    }))
  }

  const classes = palette.type === 'classes' ? buildClassRows(palette) : null
  const cmap = {
    lo,
    hi,
    center,
    mode: palette.type,
    kind: palette.type === 'classes' ? 'classes' : 'gradient',
    lut,
    toT,
    colorFor,
    rgba: (value) => {
      const color = colorFor(value)
      return color == null ? null : [color[0], color[1], color[2], 255]
    },
    classes,
    // 分级色标没有连续刻度，图例用分级边界自己生成
    edges: palette.type === 'classes' ? palette.edges : null,
    ticks,
    gradientCss: legendColors.length
      ? `linear-gradient(to right, ${legendColors.join(', ')})`
      : 'transparent',
    note: variable.legend_note ?? '',
  }
  cache.set(key, cmap)
  while (cache.size > 96) {
    cache.delete(cache.keys().next().value)
  }
  return cmap
}

// 等值线间隔（显示单位）。返回显示单位下的层级，调用方再用 toRaw 换回文件值。
export function contourLevels(variable, interval) {
  if (!interval) return []
  const lo = variable.range[0]
  const hi = variable.range[1]
  const start = Math.ceil(lo / interval) * interval
  const levels = []
  for (let value = start; value <= hi + 1e-9; value += interval) {
    levels.push(Math.round(value * 1e6) / 1e6)
  }
  return levels
}

const TICK_FORMAT = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 1,
  useGrouping: false,
})

export function formatTick(value) {
  if (Math.abs(value) >= 10000) {
    return new Intl.NumberFormat('zh-CN', {
      maximumFractionDigits: 0,
      useGrouping: false,
    }).format(value)
  }
  return TICK_FORMAT.format(value)
}
