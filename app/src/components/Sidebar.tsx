import type { Conversation } from '../lib/db'

type Props = {
  conversations: Conversation[]
  activeId: string | null
  disabled: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

export default function Sidebar({ conversations, activeId, disabled, onSelect, onCreate, onDelete }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="wordmark">hearth</span>
        <button className="ghost" onClick={onCreate} disabled={disabled} title="New conversation">
          +
        </button>
      </div>

      <nav className="conv-list">
        {conversations.length === 0 && <p className="hint">No conversations yet.</p>}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`conv ${c.id === activeId ? 'active' : ''}`}
            onClick={() => !disabled && onSelect(c.id)}
          >
            <span className="conv-title">{c.title}</span>
            <button
              className="ghost tiny"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(c.id)
              }}
              disabled={disabled}
            >
              ×
            </button>
          </div>
        ))}
      </nav>
    </aside>
  )
}
