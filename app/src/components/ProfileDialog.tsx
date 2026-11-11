import { useRef, useState } from 'react'
import Dialog from './Dialog'
import Avatar from './Avatar'
import { newId, type Persona } from '../lib/db'
import { uploadImage } from '../lib/upload'

type Props = {
  onClose: () => void
  personas: Persona[]
  activeId: string | null
  onSelect: (id: string | null) => void
  onSave: (persona: Persona) => Promise<void>
  onRemove: (id: string) => Promise<void>
  user: { name: string; avatar?: string }
  onUserAvatar: (dataUrl: string) => void
}

type Draft = {
  id: string
  name: string
  note: string
  systemPrompt: string
  avatar?: string
  createdAt: number
}

function blank(): Draft {
  return { id: newId(), name: '', note: '', systemPrompt: '', createdAt: Date.now() }
}

export default function ProfileDialog({
  onClose,
  personas,
  activeId,
  onSelect,
  onSave,
  onRemove,
  user,
  onUserAvatar,
}: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const userFile = useRef<HTMLInputElement>(null)
  const personaFile = useRef<HTMLInputElement>(null)

  async function pickUserAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const result = await uploadImage(file, 'avatar')
      onUserAvatar(result.url)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function pickPersonaAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !draft) return
    try {
      const result = await uploadImage(file, 'avatar')
      setDraft({ ...draft, avatar: result.url })
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function save() {
    if (!draft || !draft.name.trim()) return
    await onSave({
      id: draft.id,
      name: draft.name.trim(),
      note: draft.note.trim() || undefined,
      systemPrompt: draft.systemPrompt.trim() || undefined,
      avatar: draft.avatar,
      createdAt: draft.createdAt,
    })
    setDraft(null)
  }

  return (
    <Dialog title="Profiles" onClose={onClose} footer={<button onClick={onClose}>Done</button>}>
      <p className="hint">
        A profile is who the model is talking to. Its prompt is added to every
        conversation while it is active.
      </p>

      <input ref={userFile} type="file" accept="image/*" style={{ display: 'none' }} onChange={pickUserAvatar} />
      <input ref={personaFile} type="file" accept="image/*" style={{ display: 'none' }} onChange={pickPersonaAvatar} />

      <div className="you-row">
        <Avatar name={user.name} src={user.avatar} size={34} />
        <div className="you-text">
          <span className="persona-name">{user.name}</span>
          <span className="persona-note">your picture, shown on your messages</span>
        </div>
        <button className="link" onClick={() => userFile.current?.click()}>change picture</button>
      </div>

      <ul className="persona-list">
        <li className={activeId === null ? 'active' : ''}>
          <button className="persona-pick" onClick={() => onSelect(null)}>
            <span className="persona-name">No profile</span>
            <span className="persona-note">just the conversation's own prompt</span>
          </button>
        </li>

        {personas.map((p) => (
          <li key={p.id} className={activeId === p.id ? 'active' : ''}>
            <Avatar name={p.name} src={p.avatar} size={26} />
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
                    avatar: p.avatar,
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
          <div className="you-row">
            <Avatar name={draft.name || '?'} src={draft.avatar} size={34} />
            <button className="link" onClick={() => personaFile.current?.click()}>change picture</button>
            {draft.avatar && (
              <button className="link" onClick={() => setDraft({ ...draft, avatar: undefined })}>
                remove
              </button>
            )}
          </div>

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
            <span>Description</span>
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

      {error && <div className="error">{error}</div>}
    </Dialog>
  )
}
