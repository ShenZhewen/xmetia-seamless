// 业务产品预设。一个产品 = 主填色要素 + 默认叠加图层 + 默认风层。
// 等值线画在主要素上；风羽是独立叠加层，不和主填色抢图层。
export const PRODUCTS = [
  {
    id: 'rain',
    label: '降水',
    sub: '6 / 24 / 48 / 72h',
    variable: 'TP24',
    rain: true,
    overlays: { contours: false, barbs: false },
    title: '降水量',
  },
  {
    id: 'surface',
    label: '地面天气',
    sub: '海平面气压 + 10m 风',
    variable: 'MSL',
    overlays: { contours: true, barbs: true },
    windVar: 'WSPD10',
    barbLevel: '10m',
    title: '地面天气图',
  },
  {
    id: 'z500',
    label: '500hPa',
    sub: '位势高度 + 等值线',
    variable: 'Z500',
    overlays: { contours: true, barbs: false },
    title: '500hPa 高度场',
  },
  {
    id: 't850',
    label: '850hPa',
    sub: '温度 + 等值线 + 风',
    variable: 'T850',
    overlays: { contours: true, barbs: true },
    windVar: 'WSPD850',
    barbLevel: '850hPa',
    title: '850hPa 温度与风',
  },
  {
    id: 't2m',
    label: '2m 气温',
    sub: '温度场 + 等温线',
    variable: 'T2M',
    overlays: { contours: true, barbs: false },
    title: '2m 气温',
  },
  {
    id: 'wind',
    label: '风场',
    sub: '风速填色 + 风羽',
    variable: 'WSPD10',
    overlays: { contours: true, barbs: true },
    windVar: 'WSPD10',
    barbLevel: '10m',
    title: '10m 风场',
  },
  {
    id: 'tdiff',
    label: '24h 变温',
    sub: '较 24h 前 · +30h 起',
    variable: 'TDIFF24',
    overlays: { contours: true, barbs: false },
    title: '24h 变温',
  },
  {
    id: 'pdiff',
    label: '24h 变压',
    sub: '较 24h 前 · +30h 起',
    variable: 'PDIFF24',
    overlays: { contours: true, barbs: false },
    title: '24h 变压',
  },
  // 海洋与地面分析：一个产品一张图，海洋铺海温，地面铺海平面气压，
  // 再叠 10m 风羽和 4hPa 等压线。海温数据还没到，取不到时只是不画海面填色。
  {
    id: 'analysis',
    label: '海洋与地面',
    sub: '海温 · 气压+风 · 等压线',
    variable: 'MSL',
    oceanVar: 'SST',
    overlays: { contours: true, barbs: true },
    windVar: 'WSPD10',
    barbLevel: '10m',
    title: '海洋与地面分析',
  },
  {
    id: 'custom',
    label: '单要素',
    sub: '自由浏览',
    variable: null,
    overlays: { contours: false, barbs: false },
    title: '单要素',
  },
]

export const RAIN_WINDOWS = [
  { id: 'TP', label: '6h', minLead: 6 },
  { id: 'TP24', label: '24h', minLead: 24 },
  { id: 'TP48', label: '48h', minLead: 48 },
  { id: 'TP72', label: '72h', minLead: 72 },
]

export const PRODUCT_BY_ID = Object.fromEntries(
  PRODUCTS.map((product) => [product.id, product]),
)

// 从 URL 的 var 反推最接近的产品；认不出就用单要素
export function productForVariable(variableId) {
  if (['TP', 'TP24', 'TP48', 'TP72'].includes(variableId)) return 'rain'
  const match = PRODUCTS.find(
    (product) => product.variable && product.variable === variableId,
  )
  return match?.id ?? 'custom'
}
