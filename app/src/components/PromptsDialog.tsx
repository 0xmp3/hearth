import { useState } from 'react'
import Dialog from './Dialog'
import { newId, type Prompt } from '../lib/db'

type Props = {
  onClose: () => void
  prompts: Prompt[]
  onSave: (prompt: Prompt) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onUse: (text: string) => void
  canUse: boolean
}

type Draft = { id: string; name: string; text: string; createdAt: number }

export default function PromptsDialog({ onClose, prompts, onSave, onRemove, onUse, canUse }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)

  async function save() {
    if (!draft || !draft.name.trim() || !draft.text.trim()) return
    await onSave({
      id: draft.id,
      name: draft.name.trim(),
      text: draft.text.trim(),
      createdAt: draft.createdAt,
    })
    setDraft(null)
  }

  return (
    <Dialog title="Prompt library" onClose={onClose} footer={<button onClick={onClose}>Done</button>}>
      <p className="hint">
        Reusable system prompts. Using one copies its text into this conversation —
        editing a prompt later never rewrites an existing chat.
      </p>

      <ul className="character-list">
        {prompts.length === 0 && <li className="hint">Nothing saved yet.</li>}
        {prompts.map((p) => (
          <li key={p.id}>
            <button
              className="character-pick"
              onClick={() => {
                if (!canUse) return
                onUse(p.text)
                onClose()
              }}
              title={canUse ? 'Use in this conversation' : 'Open a conversation first'}
            >
              <span className="character-name">{p.name}</span>
              <span className="character-note">{p.text.slice(0, 90)}</span>
            </button>
            <div className="character-actions">
              <button
                className="link"
                onClick={() =>
                  setDraft({ id: p.id, name: p.name, text: p.text, createdAt: p.createdAt })
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
        <div className="character-form">
          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Terse reviewer"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Prompt</span>
            <textarea
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              rows={5}
              placeholder="The system prompt text."
            />
          </label>
          <div className="row end">
            <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
            <button onClick={() => void save()} disabled={!draft.name.trim() || !draft.text.trim()}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => setDraft({ id: newId(), name: '', text: '', createdAt: Date.now() })}>
            New prompt
          </button>
        </div>
      )}
    </Dialog>
  )
}
