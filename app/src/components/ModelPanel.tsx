import { useEffect, useState } from 'react'
import { manager, type ModelDownloadState } from '../lib/backend'
import { formatBytes } from '../lib/bytes'

// The first-run cliff, closed.
//
// A stranger with no models used to get a dropdown that said "no models" and no
// way forward that did not involve reading the source. This is the button: one
// pinned GGUF from the llama.cpp project's own conversions, verified against the
// digest Hugging Face publishes for the file, refused if it does not match.
//
// It does not choose the folder for a user who already has one — `selectIfUnset`
// on the manager side only fills an empty setting, because downloading a file is
// not the same act as replacing a library.

export default function ModelPanel({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<ModelDownloadState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      setState(await manager.modelDownloads())
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [])

  const progress = state?.progress
  const phase = progress?.phase ?? 'idle'
  const downloading = phase === 'downloading' || phase === 'verifying'
  const percent = progress?.total ? Math.min(100, Math.round((progress.got / progress.total) * 100)) : 0

  // A finished download changes the model list, but only after the server is
  // restarted — the preset is built at start. Tell the app to re-read anyway, so
  // the list is right the moment the restart lands.
  useEffect(() => {
    if (phase === 'done') onChanged?.()
  }, [phase, onChanged])

  async function start(id: string) {
    setBusy(true)
    setError(null)
    try {
      await manager.downloadModel(id)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (error && !state) return <div className="error">{error}</div>
  if (!state) return <p className="hint">Checking models…</p>

  return (
    <div className="manager">
      <h4>Chat model</h4>
      <p className="hint">
        {state.modelsDir
          ? `Models folder: ${state.modelsDir}`
          : 'No models folder is set yet — downloading one below sets it to the folder Hearth manages.'}
      </p>

      {phase !== 'idle' && (
        <p className="hint">
          {phase === 'downloading'
            ? `downloading ${progress?.file ?? ''} — ${formatBytes(progress?.got ?? 0)} of ${formatBytes(progress?.total ?? 0)} (${percent}%)`
            : phase === 'verifying'
              ? 'verifying the checksum…'
              : phase === 'done'
                ? 'downloaded and verified — restart the server to load it'
                : `failed: ${progress?.error ?? 'unknown error'}`}
        </p>
      )}

      {downloading && (
        <div className="bar">
          <div className="bar-fill" style={{ width: `${percent}%` }} />
        </div>
      )}

      <ul className="character-list">
        {state.entries.map((entry) => (
          <li key={entry.id}>
            <span className="character-pick">
              <span className="character-name">{entry.name}</span>
              <span className="character-note">
                {formatBytes(entry.size)} · {entry.note}
                {entry.installed ? ' · on disk' : ''}
              </span>
            </span>
            <button
              className="link"
              disabled={busy || downloading || entry.installed}
              onClick={() => void start(entry.id)}
            >
              {entry.installed ? 'downloaded' : 'download'}
            </button>
          </li>
        ))}
      </ul>

      <p className="hint">
        Fetched from Hugging Face and checked against a pinned SHA-256 before it is used — an
        unverified file is refused, not warned about. Saved to {state.dir}
      </p>

      {error && <div className="error">{error}</div>}
    </div>
  )
}
