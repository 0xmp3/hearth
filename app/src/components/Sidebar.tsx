import type { Conversation } from '../lib/db'

type Props = {
  conversations: Conversation[]
  activeId: string | null
  disabled: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onSettings: () => void
  onProfile: () => void
  profileName: string | null
  onPin: (id: string) => void
}

export default function Sidebar({
  conversations,
  activeId,
  disabled,
  onSelect,
  onCreate,
  onDelete,
  onSettings,
  onProfile,
  profileName,
  onPin,
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
            className={`conv ${c.id === activeId ? 'active' : ''} ${c.pinnedAt ? 'pinned' : ''}`}
            onClick={() => !disabled && onSelect(c.id)}
          >
            <button
              className="pin"
              title={c.pinnedAt ? 'Unpin' : 'Pin to top'}
              onClick={(e) => {
                e.stopPropagation()
                onPin(c.id)
              }}
            >
              {c.pinnedAt ? '★' : '☆'}
            </button>
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
        <button className="foot-btn" onClick={onProfile} title="Profiles">
          <span className="foot-label">profile</span>
          <span className="foot-value">{profileName ?? 'none'}</span>
        </button>
        <button className="foot-btn" onClick={onSettings} title="Settings">
          <span className="foot-label">settings</span>
          <span className="foot-value">⚙</span>
        </button>
      </div>
    </aside>
  )
}
