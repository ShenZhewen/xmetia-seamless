// 起报串是 YYYYMMDD 或 YYYYMMDDHH（UTC），和 backend/app/services/field_service.py
// 的 _valid_time 保持同一口径；页面统一按北京时间（UTC+8）展示。
const BEIJING_OFFSET_HOURS = 8

function pad(value) {
  return String(value).padStart(2, '0')
}

export function formatValidTime(init, leadHours = 0, { withYear = true } = {}) {
  if (!init || init.length < 8) return ''
  const year = Number(init.slice(0, 4))
  const month = Number(init.slice(4, 6)) - 1
  const day = Number(init.slice(6, 8))
  const hour = init.length >= 10 ? Number(init.slice(8, 10)) : 0
  const lead = Number(leadHours) || 0
  const date = new Date(
    Date.UTC(year, month, day, hour + lead + BEIJING_OFFSET_HOURS),
  )
  const datePart = withYear
    ? `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    : `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  return `${datePart} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}
