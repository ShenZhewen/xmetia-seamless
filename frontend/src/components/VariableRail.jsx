import { displayUnit } from '../colormap.js'

const GROUP_ORDER = ['地面', '高空', '其他']

export default function VariableRail({ variables, variableId, onChange }) {
  const groups = new Map()
  for (const item of variables) {
    const key = item.group ?? '其他'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  const rank = (name) => {
    const index = GROUP_ORDER.indexOf(name)
    return index < 0 ? GROUP_ORDER.length : index
  }
  const ordered = [...groups.entries()].sort(
    ([a], [b]) => rank(a) - rank(b),
  )

  return (
    <aside className="rail">
      {ordered.map(([group, items]) => (
        <section className="rail-group" key={group}>
          <div className="rail-title">{group}</div>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`var-btn${item.id === variableId ? ' is-active' : ''}`}
              onClick={() => onChange(item.id)}
            >
              <span className="var-label">{item.label}</span>
              <span className="var-unit">{displayUnit(item)}</span>
            </button>
          ))}
        </section>
      ))}
    </aside>
  )
}
