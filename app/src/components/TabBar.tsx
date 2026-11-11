import Avatar from './Avatar'
import type { Conversation } from '../lib/db'

type Props = {
  conversations: Conversation[]
  activeId: string | null
  disabled: boolean
  user: { name: string; avatar?: string }
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onProfile: () => void
  onSettings: () => void
}

// The browser-tab layout: conversations across the top instead of down the side.
export default function TabBar({
  conversations,
  activeId,
  disabled,
  user,
  onSelect,
  onCreate,
  onDelete,
  onProfile,
  onSettings,
}: Props) {
  return (
    <div className="tabbar">
      <span className="wordmark tabbar-mark">hearth</span>

      <div className="tab-strip">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`tab ${c.id === activeId ? 'active' : ''}`}
            onClick={() => !disabled && onSelect(c.id)}
            title={c.title}
          >
            {c.pinnedAt && <span className="tab-pin">★</span>}
            <span className="tab-title">{c.title}</span>
            <button
              className="tab-close"
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

        <button className="tab-new" onClick={onCreate} disabled={disabled} title="New conversation">
          +
        </button>
      </div>

      <div className="tabbar-actions">
        <button className="rail-btn" onClick={onProfile} title="Profiles">
          <Avatar name={user.name} src={user.avatar} size={20} />
        </button>
        <button className="rail-btn" onClick={onSettings} title="Settings">
          ⚙
        </button>
      </div>
    </div>
  )
}
