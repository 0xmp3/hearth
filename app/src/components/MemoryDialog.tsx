import { useState } from 'react'
import Dialog from './Dialog'
import * as db from '../lib/db'

// What the app remembers about you.
//
// This panel is not optional. Automatic extraction will sometimes store
// something wrong or trivial, and the only defence is being able to see it and
// delete it — a memory you cannot inspect is a bias you cannot correct.

type Props = {
  memories: db.Memory[]
  capturing: boolean
  onClose: () => void
  onCapture: () => Promise<{ added: number; removed: number }>
  onChanged: () => Promise<void>
}

const SCOPE_LABEL: Record<db.MemoryScope, string> = {
  global: 'Everywhere',
  conversation: 'This conversation',
  persona: 'This character',
}

export default function MemoryDialog({
  memories,
  capturing,
  onClose,
  onCapture,
  onChanged,
}: Props) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [note, setNote] = useState<string | null>(null)

  async function add() {
    const text = draft.trim()
    if (!text) return
    const now = Date.now()
    await db.putMemory({
      id: db.newId(),
      text,
      scope: 'global',
      createdAt: now,
      updatedAt: now,
    })
    setDraft('')
    await onChanged()
  }

  async function saveEdit(m: db.Memory) {
    const text = editText.trim()
    if (!text) return
    await db.putMemory({ ...m, text, updatedAt: Date.now() })
    setEditing(null)
    await onChanged()
  }

  async function remove(id: string) {
    await db.deleteMemory(id)
    await onChanged()
  }

  async function capture() {
    setNote(null)
    const result = await onCapture()
    setNote(
      result.added || result.removed
        ? `captured ${result.added} new, removed ${result.removed}`
        : 'nothing new to remember',
    )
    await onChanged()
  }

  const groups: db.MemoryScope[] = ['global', 'conversation', 'persona']

  return (
    <Dialog
      title="Memory"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={() => void capture()} disabled={capturing}>
            {capturing ? 'Reading…' : 'Capture now'}
          </button>
          <button onClick={onClose}>Done</button>
        </>
      }
    >
      <p className="hint">
        Facts the app keeps about you, sent with every message. Extraction runs in the
        background every {20} messages; anything wrong here can be edited or deleted.
      </p>

      <div className="row">
        <input
          type="text"
          value={draft}
          placeholder="Add a fact about yourself…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <button onClick={() => void add()} disabled={!draft.trim()}>
          Add
        </button>
      </div>

      {note && <p className="hint">{note}</p>}

      {memories.length === 0 ? (
        <p className="hint">Nothing remembered yet.</p>
      ) : (
        groups.map((scope) => {
          const items = memories.filter((m) => m.scope === scope)
          if (!items.length) return null
          return (
            <section key={scope} className="setting">
              <h3>{SCOPE_LABEL[scope]}</h3>
              <ul className="memory-list">
                {items.map((m) => (
                  <li key={m.id} className="memory-item">
                    {editing === m.id ? (
                      <>
                        <input
                          type="text"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveEdit(m)
                            if (e.key === 'Escape') setEditing(null)
                          }}
                          autoFocus
                        />
                        <button className="ghost tiny" onClick={() => void saveEdit(m)}>
                          save
                        </button>
                        <button className="ghost tiny" onClick={() => setEditing(null)}>
                          cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="memory-text">{m.text}</span>
                        <button
                          className="ghost tiny"
                          onClick={() => {
                            setEditing(m.id)
                            setEditText(m.text)
                          }}
                        >
                          edit
                        </button>
                        <button className="ghost tiny" onClick={() => void remove(m.id)}>
                          ×
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )
        })
      )}
    </Dialog>
  )
}
