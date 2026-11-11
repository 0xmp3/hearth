import Avatar from './Avatar'
import type { Conversation } from '../lib/db'

type Props = {
  conversations: Conversation[]
  activeId: string | null
  disabled: boolean
  collapsed: boolean
  collapsible: boolean
  user: { name: string; avatar?: string }
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onSettings: () => void
  onProfile: () => void
  onPin: (id: string) => void
  onToggleCollapse: () => void
}

export default function Sidebar({
  conversations,
  activeId,
  disabled,
  collapsed,
  collapsible,
  user,
  onSelect,
  onCreate,
  onDelete,
  onSettings,
  onProfile,
  onPin,
  onToggleCollapse,
}: Props) {
  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <div className="sidebar-head">
          <button className="ghost tiny" onClick={onToggleCollapse} title="Expand sidebar">
            »
          </button>
        </div>

        <nav className="conv-list rail">
          <button className="rail-btn" onClick={onCreate} disabled={disabled} title="New conversation">
            +
          </button>
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`rail-conv ${c.id === activeId ? 'active' : ''} ${c.pinnedAt ? 'pinned' : ''}`}
              onClick={() => !disabled && onSelect(c.id)}
              title={c.title}
            >
              {c.title.trim()[0]?.toUpperCase() ?? '?'}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot rail">
          <button className="rail-btn" onClick={onProfile} title="Profiles">
            <Avatar name={user.name} src={user.avatar} size={20} />
          </button>
          <button className="rail-btn" onClick={onSettings} title="Settings">
            ⚙
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="wordmark">hearth</span>
        <div className="head-actions">
          <button className="ghost" onClick={onCreate} disabled={disabled} title="New conversation">
            +
          </button>
          {collapsible && (
            <button className="ghost tiny" onClick={onToggleCollapse} title="Collapse sidebar">
              «
            </button>
          )}
        </div>
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
          <span className="foot-value">{user.name}</span>
        </button>
        <button className="foot-btn" onClick={onSettings} title="Settings">
          <span className="foot-label">settings</span>
          <span className="foot-value">⚙</span>
        </button>
      </div>
    </aside>
  )
}
