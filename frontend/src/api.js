// 后端接口封装。开发环境由 vite proxy 转发 /api。
const BASE = '/api'

async function getJSON(url) {
  const response = await fetch(url)
  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = await response.json()
      if (body.detail) detail = body.detail
    } catch {
      /* 忽略非 JSON 错误体 */
    }
    throw new Error(`${response.status} ${detail}`)
  }
  return response.json()
}

export function fetchCatalog() {
  return getJSON(`${BASE}/catalog`)
}

export function fetchRuns(model, limit = 500) {
  return getJSON(`${BASE}/runs?model=${encodeURIComponent(model)}&limit=${limit}`)
}

export function fetchField({ model, init, variable, lead, stride = 4, bbox }) {
  const query = new URLSearchParams({
    model,
    init,
    var: variable,
    lead: String(lead),
    stride: String(stride),
  })
  if (bbox) {
    query.set('bbox', bbox.map((item) => item.toFixed(3)).join(','))
  }
  return getJSON(`${BASE}/field?${query}`)
}

// 后端色块图：projection=mercator 时可直接贴到 MapLibre 的 image source。
// bbox 用数据集经度（0..360）；mask 取 land / ocean。
export function imageUrl({
  model,
  init,
  variable,
  lead,
  bbox,
  projection = 'mercator',
  mask = null,
}) {
  const query = new URLSearchParams({
    model,
    init,
    var: variable,
    lead: String(lead),
    projection,
  })
  if (mask) query.set('mask', mask)
  if (bbox) query.set('bbox', bbox.map((item) => item.toFixed(3)).join(','))
  return `${BASE}/image?${query}`
}

export function fetchSeries({ model, init, variable, lat, lon }) {
  const query = new URLSearchParams({
    model,
    init,
    var: variable,
    lat: lat.toFixed(3),
    lon: lon.toFixed(3),
  })
  return getJSON(`${BASE}/series?${query}`)
}
