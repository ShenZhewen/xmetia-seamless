// 球面视图的背景星空。
//
// 星点固定在地球坐标系里（经纬度方向），地图中心一动就按球面相机重新投影，
// 所以拖着地球转的时候，星空跟着一起转，而不是一张贴在屏幕上的静态图。
//
// 画在自己的 canvas 上，放在 MapLibre 画布下面：地球段 MapLibre 的
// background 和天空层是透明的，只有球体本身不透明，星星就只在球外的
// 空间里露出来；平面段背景恢复不透明，星空自然被盖住。
//
// 为了让天球不像一张平面壁纸：星等按幂律分布（大量暗星、少量亮星），
// 亮星带柔光晕，再沿一条倾斜大圆铺一条银河带，拖动时整条带跟着球转。

const TWO_PI = Math.PI * 2
const BACKGROUND_STARS = 7200
const BAND_STARS = 7200
const BAND_BLOBS = 20

// 星点颜色偏白，混少量冷色/暖色，读起来更像真实星等
const STAR_COLORS = [
  [255, 255, 255],
  [214, 228, 255],
  [255, 238, 214],
  [190, 210, 255],
]

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

// 固定种子，每次刷新星空都一样（位置、亮度都不跳）
function mulberry32(seed) {
  return function next() {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 银河北极方向（经纬度到单位向量）。真实银河北极在（192.86°, 27.13°），
// 但那样默认东亚视角下整条带都躲在地球背后；这里把极轴转到让银河带
// 从球体边缘外侧斜穿过去的方位，拖动时能看出它绕着球转。
function directionVector(lonDeg, latDeg) {
  const lon = (lonDeg * Math.PI) / 180
  const lat = (latDeg * Math.PI) / 180
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
}

const BAND_POLE = directionVector(-75, 21)
const BAND_U = normalize(cross([0, 0, 1], BAND_POLE))
const BAND_V = cross(BAND_POLE, BAND_U)

function gaussian(random) {
  const u = Math.max(random(), 1e-9)
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v)
}

function pickColor(random) {
  const roll = random()
  if (roll < 0.78) return 0
  if (roll < 0.9) return 1
  if (roll < 0.97) return 2
  return 3
}

function bandPoint(t, offset) {
  const cosOffset = Math.cos(offset)
  const sinOffset = Math.sin(offset)
  const ct = Math.cos(t) * cosOffset
  const st = Math.sin(t) * cosOffset
  return [
    BAND_U[0] * ct + BAND_V[0] * st + BAND_POLE[0] * sinOffset,
    BAND_U[1] * ct + BAND_V[1] * st + BAND_POLE[1] * sinOffset,
    BAND_U[2] * ct + BAND_V[2] * st + BAND_POLE[2] * sinOffset,
  ]
}

function makeSky() {
  const random = mulberry32(0x5eed1a2b)
  const stars = []

  // 全天均匀星：大部分很暗，少数明显亮，亮星再叠一层光晕
  for (let i = 0; i < BACKGROUND_STARS; i += 1) {
    const z = random() * 2 - 1
    const angle = random() * TWO_PI
    const radius = Math.sqrt(1 - z * z)
    const magnitude = random()
    const halo = magnitude > 0.982
    stars.push({
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      z,
      color: pickColor(random),
      alpha: 0.05 + 0.95 * magnitude ** 3.2,
      size: 0.5 + 1.6 * magnitude ** 6,
      halo: halo ? 4.5 + 6 * ((magnitude - 0.982) / 0.018) : 0,
    })
  }

  // 银河带：绕着倾斜大圆走一圈，纬度方向按高斯分布向带中心聚集
  for (let i = 0; i < BAND_STARS; i += 1) {
    const t = random() * TWO_PI
    const offset = Math.max(-0.46, Math.min(0.46, gaussian(random) * 0.105))
    const [x, y, z] = bandPoint(t, offset)
    const magnitude = random()
    stars.push({
      x,
      y,
      z,
      color: random() < 0.55 ? 1 : 0,
      // 银河带整体压暗，只作为底噪
      alpha: 0.05 + 0.45 * magnitude ** 2.2,
      size: 0.4 + 1.1 * magnitude ** 4,
      halo: 0,
    })
  }

  // 沿银河带再铺一层很淡的云气，让整条带由“更多星星”变成“一条亮带”
  const blobs = []
  for (let i = 0; i < BAND_BLOBS; i += 1) {
    const t = random() * TWO_PI
    const offset = gaussian(random) * 0.06
    const [x, y, z] = bandPoint(t, offset)
    blobs.push({
      x,
      y,
      z,
      // 角半径 3°–6°，用屏幕焦距换算成像素
      radius: ((3 + random() * 3) * Math.PI) / 180,
      alpha: 0.02 + random() * 0.028,
    })
  }

  // 按颜色排序，画的时候 fillStyle 只需切换几次
  stars.sort((a, b) => a.color - b.color)
  return { stars, blobs }
}

const SKY = makeSky()
const STARS = SKY.stars
const BAND_GLOWS = SKY.blobs
const STAR_FILLS = STAR_COLORS.map(([r, g, b]) => `rgb(${r},${g},${b})`)

// 亮星的柔光贴图，只生成一次
let glowSprite = null
function getGlowSprite() {
  if (glowSprite) return glowSprite
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  )
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.22, 'rgba(255,255,255,0.42)')
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.1)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  glowSprite = canvas
  return canvas
}

// 银河云气：范围大、中心不亮，叠起来才像一条弥散的带
let nebulaSprite = null
function getNebulaSprite() {
  if (nebulaSprite) return nebulaSprite
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  )
  gradient.addColorStop(0, 'rgba(255,255,255,0.32)')
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.12)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  nebulaSprite = canvas
  return canvas
}

export function drawStarfield(canvas, map, visible) {
  if (!canvas || !map) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (!width || !height) return

  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'source-over'
  if (!visible) return

  const center = map.getCenter()
  const latRad = (center.lat * Math.PI) / 180
  const lonRad = (center.lng * Math.PI) / 180
  const cosLat = Math.cos(latRad)
  const sinLat = Math.sin(latRad)
  const cosLon = Math.cos(lonRad)
  const sinLon = Math.sin(lonRad)

  // 相机在地球中心方向（单位向量 c）上；屏幕上右=东(e)、上=北(n)。
  const cx = cosLat * cosLon
  const cy = cosLat * sinLon
  const cz = sinLat
  const ex = -sinLon
  const ey = cosLon
  const nx = -sinLat * cosLon
  const ny = -sinLat * sinLon
  const nz = cosLat

  // 用地图中心 1° 经/纬度的投影差反推屏幕焦距，星点和球面要素同速转动；
  // 高纬度过球心时经度方向会被压扁，改用量纬度方向。
  const origin = map.project(center)
  const delta = Math.PI / 180
  let focal
  if (cosLat > 0.25) {
    const probe = map.project([center.lng + 1, center.lat])
    focal = Math.hypot(probe.x - origin.x, probe.y - origin.y) / (delta * cosLat)
  } else {
    const direction = center.lat >= 0 ? -1 : 1
    const probe = map.project([center.lng, center.lat + direction])
    focal = Math.hypot(probe.x - origin.x, probe.y - origin.y) / delta
  }
  if (!Number.isFinite(focal) || focal <= 0) return

  const originX = origin.x
  const originY = origin.y
  const margin = 32
  const sprite = getGlowSprite()
  const nebula = getNebulaSprite()

  // 银河带云气 + 亮星光晕都用叠加混合，像真的在发光
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < BAND_GLOWS.length; i += 1) {
    const blob = BAND_GLOWS[i]
    const depth = -(blob.x * cx + blob.y * cy + blob.z * cz)
    if (depth <= 0.2) continue
    const radius = (focal * Math.tan(blob.radius)) / depth
    if (!Number.isFinite(radius) || radius <= 0) continue
    const sx = originX + (focal * (blob.x * ex + blob.y * ey)) / depth
    if (sx < -radius || sx > width + radius) continue
    const sy = originY - (focal * (blob.x * nx + blob.y * ny + blob.z * nz)) / depth
    if (sy < -radius || sy > height + radius) continue
    ctx.globalAlpha = blob.alpha
    ctx.drawImage(nebula, sx - radius, sy - radius, radius * 2, radius * 2)
  }

  // 亮星的柔光
  for (let i = 0; i < STARS.length; i += 1) {
    const star = STARS[i]
    if (!star.halo) continue
    const depth = -(star.x * cx + star.y * cy + star.z * cz)
    if (depth <= 0.15) continue
    const sx = originX + (focal * (star.x * ex + star.y * ey)) / depth
    if (sx < -margin || sx > width + margin) continue
    const sy = originY - (focal * (star.x * nx + star.y * ny + star.z * nz)) / depth
    if (sy < -margin || sy > height + margin) continue
    const radius = star.halo
    ctx.globalAlpha = 0.34
    ctx.drawImage(sprite, sx - radius, sy - radius, radius * 2, radius * 2)
  }
  ctx.globalCompositeOperation = 'source-over'

  let fill = -1
  for (let i = 0; i < STARS.length; i += 1) {
    const star = STARS[i]
    // 朝向相机的半球才看得见（depth 是视线方向的深度）
    const depth = -(star.x * cx + star.y * cy + star.z * cz)
    if (depth <= 0.15) continue

    const sx = originX + (focal * (star.x * ex + star.y * ey)) / depth
    if (sx < -margin || sx > width + margin) continue
    const sy = originY - (focal * (star.x * nx + star.y * ny + star.z * nz)) / depth
    if (sy < -margin || sy > height + margin) continue

    if (star.color !== fill) {
      fill = star.color
      ctx.fillStyle = STAR_FILLS[fill]
    }
    ctx.globalAlpha = star.alpha
    const size = star.size
    if (size < 1.1) {
      ctx.fillRect(sx - size * 0.5, sy - size * 0.5, size, size)
    } else {
      ctx.beginPath()
      ctx.arc(sx, sy, size * 0.55, 0, TWO_PI)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}
