import { useCallback, useEffect, useRef, useState } from 'react'
import { manager, type SearxngStatus } from '../lib/backend'

// The install that needs no key, no account and no card.
//
// SearXNG is a Python app, so this is the one part of Hearth that builds a
// runtime instead of unpacking a binary: a virtualenv, a pinned requirements
// file, and a process the manager owns. That makes the first run slow and worth
// showing honestly — phase, step, megabytes — rather than a spinner that says
// nothing for two minutes.

type Props = {
  onUrl: (url: string) => void
}

export default function SearxngPanel({ onUrl }: Props) {
  const [state, setState] = useState<SearxngStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await manager.searxng()
      setState(next)
      setError(null)
      return next
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll while something is moving: an install has phases, a start has a wait.
  useEffect(() => {
    const moving =
      busy ||
      state?.progress.phase === 'downloading' ||
      state?.progress.phase === 'extracting' ||
      state?.progress.phase === 'venv' ||
      state?.progress.phase === 'deps' ||
      state?.progress.phase === 'configuring' ||
      state?.progress.phase === 'resolving'

    if (moving && timer.current === null) {
      timer.current = window.setInterval(() => void refresh(), 1500)
    }
    if (!moving && timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
    }
  }, [busy, state, refresh])

  async function act(fn: () => Promise<unknown>, unable?: string) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      const next = await refresh()
      if (next?.running) onUrl(next.url)
    } catch (err) {
      setError(unable ?? (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const phase = state?.progress.phase ?? 'idle'
  const installing = ['resolving', 'downloading', 'extracting', 'venv', 'deps', 'configuring'].includes(phase)
  const pct = state?.progress.total
    ? Math.min(100, Math.round((state.progress.got / state.progress.total) * 100))
    : null

  return (
    <div className="character-form">
      {!state ? (
        <p className="hint">{error ?? 'looking for the manager…'}</p>
      ) : !state.installed && !installing ? (
        <>
          <p className="hint">
            Hearth can install its own SearXNG — about 130 MB, no key and no account. It needs
            Python 3.11 or newer;{' '}
            {state.python ? `found ${state.python.version}` : 'none was found on this machine'}.
          </p>
          <div className="row">
            <button
              onClick={() => void act(() => manager.installSearxng(), 'the install did not start')}
              disabled={busy || !state.python}
            >
              Install SearXNG
            </button>
          </div>
          {!state.python && (
            <p className="hint">
              Install Python from python.org, then reopen Settings. Without it, point at a
              SearXNG you run yourself.
            </p>
          )}
        </>
      ) : installing ? (
        <>
          <p className="hint">
            {state.progress.step ?? 'working…'}
            {pct !== null ? ` — ${pct}%` : ''}
          </p>
          {pct !== null && (
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
        </>
      ) : (
        <>
          <p className="hint">
            {state.running
              ? `Running on ${state.url.replace('http://', '')} — started ${new Date(state.startedAt ?? Date.now()).toLocaleTimeString()}`
              : `Installed${state.source ? ` ${state.source.version}` : ''}, stopped`}
          </p>
          <div className="row">
            {state.running ? (
              <button className="ghost" onClick={() => void act(() => manager.stopSearxng())} disabled={busy}>
                Stop
              </button>
            ) : (
              <button onClick={() => void act(() => manager.startSearxng(), 'it did not start')} disabled={busy}>
                Start
              </button>
            )}
            <button
              className="ghost"
              onClick={() => void act(() => manager.removeSearxng())}
              disabled={busy}
              title="Delete the installed instance and its files"
            >
              Remove
            </button>
          </div>
        </>
      )}

      {state && state.progress.phase === 'error' && (
        <div className="error">install failed: {state.progress.error}</div>
      )}
      {error && <div className="error">{error}</div>}

      {state && state.log.length > 0 && (
        <details className="hint">
          <summary>installer log</summary>
          <pre className="log">{state.log.slice(-12).join('\n')}</pre>
        </details>
      )}
    </div>
  )
}
