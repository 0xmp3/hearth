import { useState } from 'react'
import Dialog from './Dialog'
import { newId, type Persona } from '../lib/db'

type Props = {
  onClose: () => void
  personas: Persona[]
  activeId: string | null
  onSelect: (id: string | null) => void
  onSave: (persona: Persona) => Promise<void>
  onRemove: (id: string) => Promise<void>
}

type Draft = { id: string; name: string; note: string; systemPrompt: string; createdAt: number }

function blank(): Draft {
  return { id: newId(), name: '', note: '', systemPrompt: '', createdAt: Date.now() }
}

export default function ProfileDialog({ onClose, personas, activeId, onSelect, onSave, onRemove }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)

  async function save() {
    if (!draft || !draft.name.trim()) return
    await onSave({
      id: draft.id,
      name: draft.name.trim(),
      note: draft.note.trim() || undefined,
      systemPrompt: draft.systemPrompt.trim() || undefined,
      createdAt: draft.createdAt,
    })
    setDraft(null)
  }

  return (
    <Dialog
      title="Profiles"
      onClose={onClose}
      footer={<button onClick={onClose}>Done</button>}
    >
      <p className="hint">
        A profile is who the model is talking to. Its prompt is added to every
        conversation while it is active.
      </p>

      <ul className="persona-list">
        <li className={activeId === null ? 'active' : ''}>
          <button className="persona-pick" onClick={() => onSelect(null)}>
            <span className="persona-name">No profile</span>
            <span className="persona-note">just the conversation's own prompt</span>
          </button>
        </li>

        {personas.map((p) => (
          <li key={p.id} className={activeId === p.id ? 'active' : ''}>
            <button className="persona-pick" onClick={() => onSelect(p.id)}>
              <span className="persona-name">{p.name}</span>
              {p.note && <span className="persona-note">{p.note}</span>}
            </button>
            <div className="persona-actions">
              <button
                className="link"
                onClick={() =>
                  setDraft({
                    id: p.id,
                    name: p.name,
                    note: p.note ?? '',
                    systemPrompt: p.systemPrompt ?? '',
                    createdAt: p.createdAt,
                  })
                }
              >
                edit
              </button>
              <button className="link" onClick={() => void onRemove(p.id)}>delete</button>
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="persona-form">
          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Neo"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Note</span>
            <input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="one line, shown in the list"
            />
          </label>
          <label className="field">
            <span>Prompt</span>
            <textarea
              value={draft.systemPrompt}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              rows={4}
              placeholder="Who you are, how you like answers. Added to every conversation."
            />
          </label>
          <div className="row end">
            <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
            <button onClick={() => void save()} disabled={!draft.name.trim()}>Save</button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => setDraft(blank())}>New profile</button>
        </div>
      )}
    </Dialog>
  )
}
