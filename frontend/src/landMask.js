// 陆地掩膜：Natural Earth 1:50m 陆地按 0.1° 等经纬栅格化成一张 1-bit PNG
// （frontend/public/land-mask.png），「海洋与地面」产品靠它把地面气压裁到陆地、
// 把海温裁到海洋。图片在模块加载时异步读入，读入前先全部按陆地处理，
// 就绪后 FieldMap 会重画一次。
const MASK_URL = '/land-mask.png'
const MASK_WIDTH = 3600
const MASK_HEIGHT = 1800

let mask = null
let markReady = () => {}
const ready = new Promise((resolve) => {
  markReady = resolve
})

function loadMask() {
  if (typeof document === 'undefined') {
    markReady()
    return
  }
  const image = new Image()
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = MASK_WIDTH
      canvas.height = MASK_HEIGHT
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(image, 0, 0, MASK_WIDTH, MASK_HEIGHT)
      const pixels = ctx.getImageData(0, 0, MASK_WIDTH, MASK_HEIGHT).data
      const bits = new Uint8Array(MASK_WIDTH * MASK_HEIGHT)
      for (let i = 0; i < bits.length; i += 1) {
        bits[i] = pixels[i * 4] > 127 ? 1 : 0
      }
      mask = bits
    } catch (error) {
      /* 读不出来就保持“全是陆地”，主填色照常铺满 */
    }
    markReady()
  }
  image.onerror = () => markReady()
  image.src = MASK_URL
}

loadMask()

export function landMaskReady() {
  return ready
}

export function isLand(lat, lon) {
  if (!mask) return true
  // PNG 横向是 -180..180 度（第 0 列 = 西经 180），先归一化到该区间。
  const wrapped = (((lon + 180) % 360) + 360) % 360
  const col = Math.min(
    MASK_WIDTH - 1,
    Math.max(0, Math.floor((wrapped / 360) * MASK_WIDTH)),
  )
  const row = Math.min(
    MASK_HEIGHT - 1,
    Math.max(0, Math.floor(((90 - lat) / 180) * MASK_HEIGHT)),
  )
  return mask[row * MASK_WIDTH + col] === 1
}
