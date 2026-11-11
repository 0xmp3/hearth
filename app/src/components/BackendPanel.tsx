import { useEffect, useState } from 'react'
import { ctxFromArgs, manager, type ManagerStatus } from '../lib/backend'
import { formatTokens } from '../lib/budget'
import EnginePanel from './EnginePanel'

// Optional process control. If the manager is not running, this says so and
// nothing else in the app changes — the app still talks to whatever server is
// on the port.
export default function BackendPanel({ onServerChanged }: { onServerChanged?: () => void }) {
  const [status, setStatus] = useState<ManagerStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [ctx, setCtx] = useState(8192)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      const s = await manager.status()
      setStatus(s)
      setUnreachable(false)
      const running = ctxFromArgs(s.args)
      if (running) setCtx(running)
    } catch {
      setUnreachable(true)
      setStatus(null)
    }
  }

  useEffect(() => {
    // Seed the context field from saved config so the first start uses the value
    // the user last chose, not a hardcoded default. A running server wins.
    void (async () => {
      const s = await manager.status().catch(() => null)
      if (s) {
        setStatus(s)
        setUnreachable(false)
        const running = ctxFromArgs(s.args)
        if (running) setCtx(running)
      }
      const e = await manager.engine().catch(() => null)
      if (e && !s?.running) setCtx(e.config.ctx)
    })()

    const t = window.setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [])

  async function act(fn: () => Promise<ManagerStatus>) {
    setBusy(true)
    setError(null)
    try {
      setStatus(await fn())
      onServerChanged?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (unreachable) {
    return (
      <p className="hint">
        Backend manager not running. Start it with <code>npm run manager</code> in{' '}
        <code>app/</code> to let the app launch and stop the server itself. Without it,
        the app uses whatever is already listening.
      </p>
    )
  }

  if (!status) return <p className="hint">Checking manager…</p>

  const runningCtx = ctxFromArgs(status.args)

  return (
    <div className="manager">
      <EnginePanel onChanged={onServerChanged} />

      <div className="manager-row">
        <span className={`dot ${status.running ? 'on' : 'off'}`} />
        <span className="manager-state">
          {status.running ? `running · pid ${status.pid}` : 'stopped'}
        </span>
        {runningCtx ? <span className="footnote">context {formatTokens(runningCtx)}</span> : null}
      </div>

      <label className="field">
        <span>Context size</span>
        <input
          type="number"
          min={512}
          step={512}
          value={ctx}
          onChange={(e) => setCtx(Number(e.target.value))}
          disabled={busy}
        />
        <em className="hint">
          passed as <code>-c</code> when the server starts. Changing it needs a restart —
          llama.cpp sizes the KV cache at load and cannot resize it live.
        </em>
      </label>

      <div className="row">
        {status.running ? (
          <>
            <button onClick={() => void act(() => manager.stop())} disabled={busy}>
              Stop server
            </button>
            <button
              className="ghost"
              onClick={() => void act(async () => {
                await manager.stop()
                await new Promise((r) => setTimeout(r, 800))
                return manager.start({ ctx })
              })}
              disabled={busy}
            >
              Restart with {formatTokens(ctx)}
            </button>
          </>
        ) : (
          <button onClick={() => void act(() => manager.start({ ctx }))} disabled={busy}>
            Start server
          </button>
        )}
      </div>

      {status.error && <div className="error">{status.error}</div>}
      {error && <div className="error">{error}</div>}

      {status.log.length > 0 && (
        <pre className="manager-log">{status.log.slice(-12).join('\n')}</pre>
      )}
    </div>
  )
}
