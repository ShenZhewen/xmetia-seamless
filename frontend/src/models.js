// 模型强调色：顶栏、点时序曲线共用一套，别在两个地方各写一份。
export const MODEL_COLORS = {
  fuxi: '#4ea1ff',
  fgvp: '#34d399',
  aifs: '#f59e0b',
  fengqing: '#c084fc',
  tongyun: '#22d3ee',
}

export function modelColor(id) {
  return MODEL_COLORS[id] ?? '#4ea1ff'
}
