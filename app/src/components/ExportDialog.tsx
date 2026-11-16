import { useMemo, useState } from 'react'
import Dialog from './Dialog'
import type { Conversation } from '../lib/db'

type Props = {
  onClose: () => void
  conversations: Conversation[]
  activeId: string | null
  onExport: (scope: 'all' | string) => void
}

export default function ExportDialog({ onClose, conversations, activeId, onExport }: Props) {
  const [scope, setScope] = useState<'all' | 'one'>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(activeId ?? conversations[0]?.id ?? null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return conversations.filter((c) => !q || c.title.toLowerCase().includes(q))
  }, [conversations, query])

  const canExport = scope === 'all' ? conversations.length > 0 : Boolean(selected)

  return (
    <Dialog
      title="Export"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button
            onClick={() => {
              if (scope === 'all') onExport('all')
              else if (selected) onExport(selected)
              onClose()
            }}
            disabled={!canExport}
          >
            Export
          </button>
        </>
      }
    >
      <label className="choice">
        <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
        <span>
          All conversations
          <em>{conversations.length} chat{conversations.length === 1 ? '' : 's'}, plus profiles</em>
        </span>
      </label>

      <label className="choice">
        <input type="radio" checked={scope === 'one'} onChange={() => setScope('one')} />
        <span>
          A specific conversation
          <em>one chat, restorable on its own</em>
        </span>
      </label>

      {scope === 'one' && (
        <div className="picker">
          <input
            className="picker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            autoFocus
          />
          <ul className="picker-list">
            {matches.length === 0 && <li className="picker-empty">Nothing matches.</li>}
            {matches.map((c) => (
              <li
                key={c.id}
                className={c.id === selected ? 'active' : ''}
                onClick={() => setSelected(c.id)}
              >
                {c.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="hint">
        A backup is plain text: every message, prompt and memory in the file, readable by
        anything that opens it. Store it like a document, not like a password.
      </p>
    </Dialog>
  )
}
