import type { Conversation } from '../lib/db'

type Props = {
  conversations: Conversation[]
  activeId: string | null
  disabled: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  themeId: string
  themes: { id: string; name: string }[]
  onTheme: (id: string) => void
  onBackup: () => void
  onRestore: () => void
}

export default function Sidebar({
  conversations,
  activeId,
  disabled,
  onSelect,
  onCreate,
  onDelete,
  themeId,
  themes,
  onTheme,
  onBackup,
  onRestore,
}: Props) {
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

      <div className="sidebar-foot">
        <select
          className="theme-select"
          value={themeId}
          onChange={(e) => onTheme(e.target.value)}
          title="Theme"
        >
          {themes.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        <div className="foot-actions">
          <button className="foot-link" onClick={onBackup} title="Save every conversation to a JSON file">
            backup
          </button>
          <button className="foot-link" onClick={onRestore} title="Restore conversations from a backup file">
            restore
          </button>
        </div>
      </div>
    </aside>
  )
}
