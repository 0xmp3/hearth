import { useEffect, useState } from 'react'
import { manager, type EngineStatus } from '../lib/backend'

// Which llama.cpp binary the app will run, and where it came from.
//
// Nothing here is hardcoded: the manager resolves the engine from an env var, a
// saved path, or a build this app downloaded itself. If none of those exist,
// this panel offers to fetch one for the detected hardware.

const SOURCE_LABEL: Record<string, string> = {
  env: 'from HEARTH_LLAMA',
  config: 'set below',
  managed: 'downloaded by Hearth',
  none: 'not found',
}

function mb(bytes: number) {
  return `${(bytes / 1048576).toFixed(0)} MB`
}

export default function EnginePanel({ onChanged }: { onChanged?: () => void }) {
  const [info, setInfo] = useState<EngineStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      const s = await manager.engine()
      setInfo(s)
      setPath(s.config.enginePath ?? '')
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

  if (error && !info) return <div className="error">{error}</div>
  if (!info) return <p className="hint">Checking engine…</p>

  const { detected, source, engine, managed, progress, installing } = info
  const pct = progress.total ? Math.min(100, (progress.got / progress.total) * 100) : 0
  const downloading = installing || progress.phase === 'downloading' || progress.phase === 'extracting'

  async function save(patch: { enginePath?: string | null }) {
    setBusy(true)
    setError(null)
    try {
      await manager.saveConfig(patch)
      await refresh()
      onChanged?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function download() {
    setBusy(true)
    setError(null)
    try {
      await manager.downloadEngine()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="engine">
      <div className="engine-machine">
        <span className="footnote">
          {detected.os} · {detected.arch} · {detected.gpu.name}
        </span>
      </div>

      <div className="engine-row">
        <span className={`dot ${engine.exists ? 'on' : 'off'}`} />
        <span className="engine-path" title={engine.path ?? ''}>
          {engine.path ?? 'no engine'}
        </span>
        <span className="badge">{SOURCE_LABEL[engine.source]}</span>
      </div>

      {!engine.exists && source && (
        <div className="engine-offer">
          <p className="hint">
            Nothing to run yet. Hearth can fetch <strong>{source.label}</strong> for this
            machine and unpack it into <code>data/engine/</code>.
          </p>
          <button onClick={() => void download()} disabled={busy || downloading}>
            {downloading ? 'Downloading…' : `Download ${source.label}`}
          </button>
        </div>
      )}

      {downloading && (
        <div className="engine-progress">
          <div className="bar">
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="footnote">
            {progress.phase} · {mb(progress.got)} / {progress.total ? mb(progress.total) : '?'}
            {progress.version ? ` · ${progress.version}` : ''}
          </span>
        </div>
      )}

      {progress.phase === 'done' && (
        <p className="hint">
          Installed {progress.version}
          {progress.verified === true
            ? ' · checksum verified'
            : progress.verified === false
              ? ' · no published checksum for this build'
              : ''}
        </p>
      )}

      {progress.phase === 'error' && <div className="error">{progress.error}</div>}

      {managed.installed && engine.source !== 'managed' && (
        <button className="ghost" onClick={() => void save({ enginePath: null })} disabled={busy}>
          Use the downloaded engine
        </button>
      )}

      <label className="field">
        <span>Engine path</span>
        <input
          type="text"
          value={path}
          placeholder="leave empty to use the downloaded engine"
          onChange={(e) => setPath(e.target.value)}
          onBlur={() => {
            const next = path.trim() || null
            if (next !== (info.config.enginePath ?? null)) void save({ enginePath: next })
          }}
          disabled={busy}
        />
        <em className="hint">
          Point this at any <code>llama-server</code> you already have. Empty means use the
          one Hearth downloaded.
        </em>
      </label>

      {error && <div className="error">{error}</div>}
    </div>
  )
}
