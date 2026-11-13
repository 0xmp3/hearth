import { useRef, useState } from 'react'
import Dialog from './Dialog'
import Avatar from './Avatar'
import { newId, type Character, type Profile } from '../lib/db'
import { uploadImage } from '../lib/upload'

// Two lists that look alike and mean opposite things:
//
//   Profiles   — who you are. What the model sees when it replies to you.
//   Characters — who the model is. What it speaks as.
//
// Both are app-wide with a per-conversation override, so both show the same
// "active" affordance. Watching them side by side is the point: the old naming
// had the model's identity called a "profile", which is why the two were
// constantly confused.

type Props = {
  onClose: () => void

  profiles: Profile[]
  activeProfileId: string | null
  onSelectProfile: (id: string) => void
  onSaveProfile: (p: Profile) => Promise<void>
  onRemoveProfile: (id: string) => Promise<void>

  characters: Character[]
  activeCharacterId: string | null
  onSelectCharacter: (id: string | null) => void
  onSaveCharacter: (c: Character) => Promise<void>
  onRemoveCharacter: (id: string) => Promise<void>

  /** Clips the manager knows about; empty when speech is not set up. */
  voices?: { id: string; name: string }[]

  /** The model's own identity, used when no character is active. */
  assistant: { name: string; avatar?: string }
  onAssistantName: (name: string) => void
  onAssistantAvatar: (url: string) => void
}

type ProfileDraft = { id: string; name: string; description: string; avatar?: string; createdAt: number }
type CharacterDraft = {
  id: string
  name: string
  note: string
  systemPrompt: string
  avatar?: string
  /** '' means the app-wide voice. */
  voice?: string
  /** 0–359. Undefined means "no colour of their own". */
  hue?: number
  createdAt: number
}

const blankProfile = (): ProfileDraft => ({
  id: newId(),
  name: '',
  description: '',
  createdAt: Date.now(),
})

const blankCharacter = (): CharacterDraft => ({
  id: newId(),
  name: '',
  note: '',
  systemPrompt: '',
  voice: '',
  createdAt: Date.now(),
})

export default function ProfileDialog(props: Props) {
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null)
  const [characterDraft, setCharacterDraft] = useState<CharacterDraft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const profileFile = useRef<HTMLInputElement>(null)
  const characterFile = useRef<HTMLInputElement>(null)
  const assistantFile = useRef<HTMLInputElement>(null)

  async function pick(
    e: React.ChangeEvent<HTMLInputElement>,
    apply: (url: string) => void,
  ) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      apply((await uploadImage(file, 'avatar')).url)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function saveProfile() {
    if (!profileDraft?.name.trim()) return
    await props.onSaveProfile({
      id: profileDraft.id,
      name: profileDraft.name.trim(),
      description: profileDraft.description.trim() || undefined,
      avatar: profileDraft.avatar,
      createdAt: profileDraft.createdAt,
    })
    setProfileDraft(null)
  }

  async function saveCharacter() {
    if (!characterDraft?.name.trim()) return
    await props.onSaveCharacter({
      id: characterDraft.id,
      name: characterDraft.name.trim(),
      note: characterDraft.note.trim() || undefined,
      systemPrompt: characterDraft.systemPrompt.trim() || undefined,
      voice: characterDraft.voice || undefined,
      hue: characterDraft.hue,
      avatar: characterDraft.avatar,
      createdAt: characterDraft.createdAt,
    })
    setCharacterDraft(null)
  }

  return (
    <Dialog title="Profiles and characters" onClose={props.onClose} footer={<button onClick={props.onClose}>Done</button>}>
      <input ref={profileFile} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={(e) => void pick(e, (url) => setProfileDraft((d) => (d ? { ...d, avatar: url } : d)))} />
      <input ref={characterFile} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={(e) => void pick(e, (url) => setCharacterDraft((d) => (d ? { ...d, avatar: url } : d)))} />
      <input ref={assistantFile} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={(e) => void pick(e, props.onAssistantAvatar)} />

      {/* ---- you ---- */}
      <section className="setting">
        <h3>You</h3>
        <p className="hint">
          Who the model is talking to. Memory is shared across profiles — a profile is how
          you introduce yourself, not a different person.
        </p>

        <ul className="character-list">
          {props.profiles.map((p) => (
            <li key={p.id} className={props.activeProfileId === p.id ? 'active' : ''}>
              <Avatar name={p.name} src={p.avatar} size={26} />
              <button className="character-pick" onClick={() => props.onSelectProfile(p.id)}>
                <span className="character-name">{p.name}</span>
                {p.description && <span className="character-note">{p.description}</span>}
              </button>
              <div className="character-actions">
                <button
                  className="link"
                  onClick={() =>
                    setProfileDraft({
                      id: p.id,
                      name: p.name,
                      description: p.description ?? '',
                      avatar: p.avatar,
                      createdAt: p.createdAt,
                    })
                  }
                >
                  edit
                </button>
                {props.profiles.length > 1 && (
                  <button className="link" onClick={() => void props.onRemoveProfile(p.id)}>
                    delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        {profileDraft ? (
          <div className="character-form">
            <div className="you-row">
              <Avatar name={profileDraft.name || '?'} src={profileDraft.avatar} size={34} />
              <button className="link" onClick={() => profileFile.current?.click()}>
                change picture
              </button>
              {profileDraft.avatar && (
                <button className="link" onClick={() => setProfileDraft({ ...profileDraft, avatar: undefined })}>
                  remove
                </button>
              )}
            </div>
            <label className="field">
              <span>Name</span>
              <input
                value={profileDraft.name}
                onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })}
                placeholder="e.g. Neo"
                autoFocus
              />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                value={profileDraft.description}
                onChange={(e) => setProfileDraft({ ...profileDraft, description: e.target.value })}
                rows={3}
                placeholder="A line about you, sent with every message while this profile is active."
              />
            </label>
            <div className="row end">
              <button className="ghost" onClick={() => setProfileDraft(null)}>Cancel</button>
              <button onClick={() => void saveProfile()} disabled={!profileDraft.name.trim()}>Save</button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button onClick={() => setProfileDraft(blankProfile())}>New profile</button>
          </div>
        )}
      </section>

      {/* ---- the model ---- */}
      <section className="setting">
        <h3>The model</h3>
        <p className="hint">
          Who it speaks as. A character's prompt is added to every conversation while it is
          active; with none, it is just the model.
        </p>

        <div className="you-row">
          <Avatar name={props.assistant.name} src={props.assistant.avatar} size={34} />
          <div className="you-text">
            <input
              className="inline-name"
              value={props.assistant.name}
              onChange={(e) => props.onAssistantName(e.target.value)}
              placeholder="Hearth"
            />
            <span className="character-note">its own identity, when no character is active</span>
          </div>
          <button className="link" onClick={() => assistantFile.current?.click()}>
            change picture
          </button>
        </div>

        <ul className="character-list">
          <li className={props.activeCharacterId === null ? 'active' : ''}>
            <button className="character-pick" onClick={() => props.onSelectCharacter(null)}>
              <span className="character-name">No character</span>
              <span className="character-note">just the conversation's own prompt</span>
            </button>
          </li>

          {props.characters.map((c) => (
            <li key={c.id} className={props.activeCharacterId === c.id ? 'active' : ''}>
              <Avatar name={c.name} src={c.avatar} size={26} />
              <button className="character-pick" onClick={() => props.onSelectCharacter(c.id)}>
                <span className="character-name">{c.name}</span>
                {c.note && <span className="character-note">{c.note}</span>}
              </button>
              <div className="character-actions">
                <button
                  className="link"
                  onClick={() =>
                    setCharacterDraft({
                      id: c.id,
                      name: c.name,
                      note: c.note ?? '',
                      systemPrompt: c.systemPrompt ?? '',
                      voice: c.voice ?? '',
                      hue: c.hue,
                      avatar: c.avatar,
                      createdAt: c.createdAt,
                    })
                  }
                >
                  edit
                </button>
                <button className="link" onClick={() => void props.onRemoveCharacter(c.id)}>
                  delete
                </button>
              </div>
            </li>
          ))}
        </ul>

        {characterDraft ? (
          <div className="character-form">
            <div className="you-row">
              <Avatar name={characterDraft.name || '?'} src={characterDraft.avatar} size={34} />
              <button className="link" onClick={() => characterFile.current?.click()}>
                change picture
              </button>
              {characterDraft.avatar && (
                <button className="link" onClick={() => setCharacterDraft({ ...characterDraft, avatar: undefined })}>
                  remove
                </button>
              )}
            </div>
            <label className="field">
              <span>Name</span>
              <input
                value={characterDraft.name}
                onChange={(e) => setCharacterDraft({ ...characterDraft, name: e.target.value })}
                placeholder="e.g. Elara"
                autoFocus
              />
            </label>
            <label className="field">
              <span>Description</span>
              <input
                value={characterDraft.note}
                onChange={(e) => setCharacterDraft({ ...characterDraft, note: e.target.value })}
                placeholder="one line, shown in the list"
              />
            </label>
            <label className="field">
              <span>Prompt</span>
              <textarea
                value={characterDraft.systemPrompt}
                onChange={(e) => setCharacterDraft({ ...characterDraft, systemPrompt: e.target.value })}
                rows={4}
                placeholder="Who they are, how they speak. Added to every conversation."
              />
            </label>
            <label className="field">
              <span>Voice</span>
              <select
                value={characterDraft.voice ?? ''}
                onChange={(e) => setCharacterDraft({ ...characterDraft, voice: e.target.value })}
                disabled={!props.voices?.length}
              >
                <option value="">app default</option>
                {(props.voices ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Colour</span>
              <div className="hue-row">
                <input
                  type="range"
                  min={0}
                  max={359}
                  value={characterDraft.hue ?? 28}
                  onChange={(e) => setCharacterDraft({ ...characterDraft, hue: Number(e.target.value) })}
                  className="hue-slider"
                  style={{ ['--voice-h' as string]: characterDraft.hue ?? 28 } as React.CSSProperties}
                />
                <span
                  className="hue-swatch"
                  style={{ ['--voice-h' as string]: characterDraft.hue ?? 28 } as React.CSSProperties}
                >
                  {characterDraft.hue === undefined ? 'none' : characterDraft.hue}
                </span>
                {characterDraft.hue !== undefined && (
                  <button className="link" onClick={() => setCharacterDraft({ ...characterDraft, hue: undefined })}>
                    clear
                  </button>
                )}
              </div>
            </label>
            <div className="row end">
              <button className="ghost" onClick={() => setCharacterDraft(null)}>Cancel</button>
              <button onClick={() => void saveCharacter()} disabled={!characterDraft.name.trim()}>Save</button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button onClick={() => setCharacterDraft(blankCharacter())}>New character</button>
          </div>
        )}
      </section>

      {error && <div className="error">{error}</div>}
    </Dialog>
  )
}
