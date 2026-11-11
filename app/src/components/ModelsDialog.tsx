import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import {
  ensurePermission,
  formatSize,
  listModels,
  loadNotes,
  pickDirectory,
  savedDirectory,
  saveNote,
  supported,
  type ModelFile,
} from '../lib/modelsDir'

type Props = { onClose: () => void }

export default function ModelsDialog({ onClose }: Props) {
  const [models, setModels] = useState<ModelFile[] | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hasDir, setHasDir] = useState(false)

  async function scan(handle: FileSystemDirectoryHandle) {
    setBusy(true)
    setError(null)
    try {
      if (!(await ensurePermission(handle))) {
        setError('permission to read that folder was not granted')
        setModels(null)
        return
      }
      setModels(await listModels(handle))
      setNotes(await loadNotes())
      setHasDir(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void (async () => {
      const handle = await savedDirectory()
      if (handle) await scan(handle)
      else setModels(null)
    })()
  }, [])

  async function choose() {
    try {
      const handle = await pickDirectory()
      if (handle) await scan(handle)
    } catch (err) {
      // Cancelling the picker throws; that is not an error worth showing.
      if ((err as Error).name !== 'AbortError') setError((err as Error).message)
    }
  }

  async function refresh() {
    const handle = await savedDirectory()
    if (handle) await scan(handle)
  }

  return (
    <Dialog
      title="Models"
      onClose={onClose}
      wide
      footer={
        <>
          {hasDir && <button className="ghost" onClick={() => void refresh()} disabled={busy}>Refresh</button>}
          {hasDir && <button className="ghost" onClick={() => void choose()}>Change folder…</button>}
          <button className="ghost" onClick={onClose}>Done</button>
        </>
      }
    >
      {!supported() ? (
        <p className="hint">
          This browser cannot read a folder. The File System Access API needs Chrome, Edge
          or another Chromium browser — the native shell will not have this limit.
        </p>
      ) : (
        <p className="hint">
          Point this at the folder your GGUF files live in. It is a viewer, not a launcher:
          the server still decides what it serves.
        </p>
      )}

      {models === null && supported() && (
        <div className="row">
          <button onClick={() => void choose()}>Choose models folder…</button>
        </div>
      )}

      {busy && <p className="hint">Reading…</p>}

      {models && models.length === 0 && (
        <p className="hint">No .gguf files in that folder.</p>
      )}

      {models && models.length > 0 && (
        <>
          <p className="hint">
            {models.length} model{models.length === 1 ? '' : 's'} ·{' '}
            {formatSize(models.reduce((a, m) => a + m.size, 0))} total
          </p>

          <ul className="model-list">
            {models.map((m) => (
              <li key={m.name}>
                <div className="model-head">
                  <span className="model-name">{m.name}</span>
                  <span className="footnote">{formatSize(m.size)}</span>
                </div>
                <div className="model-tags">
                  {m.params && <span className="tag">{m.params}</span>}
                  {m.experts && <span className="tag">{m.experts} active</span>}
                  {m.quant && <span className="tag">{m.quant}</span>}
                </div>
                <input
                  className="model-note"
                  value={notes[m.name] ?? ''}
                  placeholder="Add a description…"
                  onChange={(e) => setNotes({ ...notes, [m.name]: e.target.value })}
                  onBlur={(e) => void saveNote(m.name, e.target.value)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <div className="error">{error}</div>}
    </Dialog>
  )
}
