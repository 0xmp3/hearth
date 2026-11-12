import { useCallback, useEffect, useRef, useState } from 'react'
import { manager, type SpeechState } from '../lib/backend'

// Speech Settings.
//
// The engine is the llama.cpp build Hearth already installs, so there is nothing
// to download here — only two GGUF paths and the voice clips. A voice is a
// reference recording, not a name in a list, which is why the import button is
// the centre of this panel and why nothing ships with the app.
//
// The manager starts a second model server when it first needs one and stops it
// after ten quiet minutes; this panel says which of those states it is in,
// because "no sound" and "still loading 1.6 GB" look identical otherwise.

type Props = {
  onState?: (state: SpeechState | null) => void
  /** Speak every reply when it finishes. */
  autoSpeak: boolean
  onAutoSpeak: (value: boolean) => void
  /** Voice for characters that do not pin one. */
  defaultVoice: string
  onDefaultVoice: (id: string) => void
}

const LANGS = [
  ['en', 'English'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['ru', 'Russian'],
]

function megabytes(bytes: number) {
  return `${(bytes / 1e6).toFixed(0)} MB`
}

export default function SpeechPanel({ onState, autoSpeak, onAutoSpeak, defaultVoice, onDefaultVoice }: Props) {
  const [state, setState] = useState<SpeechState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lang, setLang] = useState('en')
  const [ngl, setNgl] = useState('99')
  const [test, setTest] = useState('Hearth can speak now, in a voice you gave it.')
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await manager.tts()
      setState(next)
      onState?.(next)
      setLang(next.lang)
      setNgl(String(next.ngl))
      return next
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }, [onState])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function act(fn: () => Promise<unknown>, unable?: string) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(unable ?? (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function importFile(file: File) {
    const ext = file.name.split('.').pop() ?? ''
    const name = file.name.replace(/\.[^.]+$/, '')
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = () => reject(new Error('could not read that file'))
      reader.readAsDataURL(file)
    })
    await act(() => manager.importVoice({ name, ext, data }), 'that clip could not be imported')
  }

  async function preview() {
    const voice = state?.voices[0]?.id
    if (!voice) return
    setBusy(true)
    setError(null)
    try {
      const bytes = await manager.speak(test, voice)
      if (!bytes) throw new Error('the engine returned no audio')
      const ctx = new AudioContext()
      const buffer = await ctx.decodeAudioData(bytes)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.onended = () => void ctx.close()
      source.start()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="character-form">
      {!state ? (
        <p className="hint">{error ?? 'looking for the manager…'}</p>
      ) : (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={state.enabled}
              disabled={busy}
              onChange={(e) => void act(() => manager.saveTts({ enabled: e.target.checked }))}
            />
            Speak replies aloud
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(e) => onAutoSpeak(e.target.checked)}
            />
            Read each reply as it finishes
          </label>

          <p className="hint">
            {state.serverRunning
              ? `engine warm on port ${state.port}`
              : state.enabled
                ? 'engine starts on the first thing you say'
                : 'the engine stays off until this is on'}
            {' · '}
            {state.cacheFiles} cached sentence{state.cacheFiles === 1 ? '' : 's'}
            {state.error ? ` · ${state.error}` : ''}
          </p>

          <label className="field">
            <span>TTS backbone (GGUF)</span>
            <input
              value={state.model.path}
              placeholder="Qwen3-TTS-…-Base-Q4_K_M.gguf"
              onChange={(e) => void act(() => manager.saveTts({ model: e.target.value }))}
            />
          </label>
          <label className="field">
            <span>Audio codec (mmproj)</span>
            <input
              value={state.mmproj.path}
              placeholder="mmproj-Qwen3-TTS-…gguf"
              onChange={(e) => void act(() => manager.saveTts({ mmproj: e.target.value }))}
            />
          </label>

          <div className="row">
            <label className="field">
              <span>Language</span>
              <select
                value={lang}
                disabled={busy}
                onChange={(e) => {
                  setLang(e.target.value)
                  void act(() => manager.saveTts({ lang: e.target.value }))
                }}
              >
                {LANGS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>GPU layers</span>
              <input
                type="number"
                min={0}
                max={999}
                value={ngl}
                disabled={busy}
                onChange={(e) => setNgl(e.target.value)}
                onBlur={() => void act(() => manager.saveTts({ ngl: Number(ngl) }))}
              />
            </label>
          </div>

          {state.voices.length > 0 && (
            <label className="field">
              <span>Default voice</span>
              <select value={defaultVoice} onChange={(e) => onDefaultVoice(e.target.value)}>
                <option value="">first clip</option>
                {state.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <h4>Voices</h4>
          <p className="hint">
            A clip of someone speaking — five to twenty seconds is plenty. The model copies the
            voice, not the language: a Japanese recording can read English in the same timbre.
            Only use recordings you have the right to.
          </p>

          <div className="row">
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void importFile(file)
              }}
            />
            <button onClick={() => fileInput.current?.click()} disabled={busy}>
              Import a clip
            </button>
            {state.voices.length > 0 && (
              <button className="ghost" onClick={() => void preview()} disabled={busy || !state.ready}>
                Say it
              </button>
            )}
          </div>

          {state.voices.length === 0 ? (
            <p className="hint">No clips yet — speech stays silent until there is one.</p>
          ) : (
            <ul className="character-list">
              {state.voices.map((voice) => (
                <li key={voice.id}>
                  <span className="character-pick">
                    <span className="character-name">{voice.name}</span>
                    <span className="character-note">
                      {voice.ext.toUpperCase()} · {megabytes(voice.bytes)}
                    </span>
                  </span>
                  <button
                    className="link"
                    disabled={busy}
                    onClick={() =>
                      void act(() => manager.removeVoice(voice.id), 'that clip could not be removed')
                    }
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {state.voices.length > 0 && (
            <label className="field">
              <span>Test phrase</span>
              <input value={test} onChange={(e) => setTest(e.target.value)} />
            </label>
          )}

          {!state.ready && state.enabled && (
            <p className="hint">
              Speech needs the llama.cpp engine, both GGUF files and at least one clip. Missing:{' '}
              {[
                !state.engine.exists ? 'engine' : null,
                !state.model.exists ? 'backbone' : null,
                !state.mmproj.exists ? 'codec' : null,
                state.voices.length === 0 ? 'a voice clip' : null,
              ]
                .filter(Boolean)
                .join(', ')}
              .
            </p>
          )}

          {error && <p className="hint warn">{error}</p>}
        </>
      )}
    </div>
  )
}
