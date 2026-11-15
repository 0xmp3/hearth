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
  /** Named so a character fact says *which* character, not just "this one". */
  characters?: db.Character[]
  /** The character a fact typed here belongs to. Null means the empty partition. */
  characterId?: string | null
  capturing: boolean
  condensing: boolean
  onClose: () => void
  onCapture: () => Promise<{ added: number; removed: number }>
  /** Condense the oldest turns of the open conversation. Null when it refused. */
  onCondense: () => Promise<{ condensed: number; total: number } | null>
  onChanged: () => Promise<void>
}

const SCOPE_LABEL: Record<db.MemoryScope, string> = {
  conversation: 'This conversation',
  character: 'This character',
}

export default function MemoryDialog({
  memories,
  characters = [],
  characterId = null,
  capturing,
  condensing,
  onClose,
  onCapture,
  onCondense,
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
      // A fact typed here belongs to the character you are talking to, which is
      // the same place the extractor puts one. There is no app-wide memory.
      scope: 'character',
      ownerId: characterId ?? undefined,
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

  async function keep(m: db.Memory) {
    await db.putMemory({ ...m, pending: false, updatedAt: Date.now() })
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

  async function condense() {
    setNote(null)
    const result = await onCondense()
    setNote(
      result
        ? `condensed ${result.condensed} messages into a summary covering ${result.total}`
        : 'nothing to condense yet — needs a longer conversation',
    )
    await onChanged()
  }

  // A summary is not a fact, and it is too long to sit in the fact lists.
  const summaries = memories.filter((m) => m.kind === 'summary')
  // Pending facts are proposals, not memories: they are not in any prompt until
  // they are kept, so they get their own section at the top.
  const pending = memories.filter((m) => m.kind !== 'summary' && m.pending)
  const facts = memories.filter((m) => m.kind !== 'summary' && !m.pending)
  const groups: db.MemoryScope[] = ['character', 'conversation']

  /**
   * A character fact belongs to one character, and "This character" is a lie once
   * there is more than one. The owner is the id, so the name is a lookup — and a
   * deleted character is named as such rather than silently relabelled.
   */
  function labelFor(m: db.Memory): string {
    if (m.scope !== 'character') return SCOPE_LABEL[m.scope]
    const owner = characters.find((c) => c.id === m.ownerId)
    return owner ? owner.name : 'a deleted character'
  }

  return (
    <Dialog
      title="Memory"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={() => void condense()} disabled={condensing}>
            {condensing ? 'Condensing…' : 'Condense now'}
          </button>
          <button className="ghost" onClick={() => void capture()} disabled={capturing}>
            {capturing ? 'Reading…' : 'Capture now'}
          </button>
          <button onClick={onClose}>Done</button>
        </>
      }
    >
      <p className="hint">
        Facts the app keeps about you, sent with every message. The model offers them as you talk and
        you decide what stays; a background sweep catches the rest every 40 messages. Anything here can
        be edited or deleted.
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

      {summaries.length > 0 && (
        <section className="setting">
          <h3>Condensed history</h3>
          <p className="hint">
            The oldest turns of this conversation, summarised and sent in their place. The
            transcript itself is untouched — delete the summary and the whole thing is sent again.
          </p>
          <ul className="memory-list">
            {summaries.map((m) => (
              <li key={m.id} className="memory-item">
                {editing === m.id ? (
                  <>
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={6}
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
                    <span className="memory-text">
                      <span className="character-note">
                        {m.messageCount ? `${m.messageCount} messages` : 'earlier turns'}
                      </span>
                      {m.text}
                    </span>
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
      )}

      {pending.length > 0 && (
        <section className="setting">
          <h3>Waiting for you</h3>
          <p className="hint">
            The model offered these. They are not in any prompt until you keep them.
          </p>
          <ul className="memory-list">
            {pending.map((m) => (
              <li key={m.id} className="memory-item">
                <span className="memory-text">
                  <span className="character-note">{labelFor(m)}</span>
                  {m.text}
                </span>
                <button className="ghost tiny" onClick={() => void keep(m)}>
                  keep
                </button>
                <button className="ghost tiny" onClick={() => void remove(m.id)}>
                  forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {facts.length === 0 && summaries.length === 0 ? (
        <p className="hint">Nothing remembered yet.</p>
      ) : (
        groups.map((scope) => {
          const items = facts.filter((m) => m.scope === scope)
          if (!items.length) return null
          return (
            <section key={scope} className="setting">
              <h3>{scope === 'character' ? 'Characters' : SCOPE_LABEL[scope]}</h3>
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
