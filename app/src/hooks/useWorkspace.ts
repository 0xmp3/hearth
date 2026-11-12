// The folder the model may read.
//
// Like the network switch, this is the manager's decision and the app's view of
// it: the browser cannot read a filesystem, so the path lives in
// data/config.json, the manager validates it there, and the app only learns
// whether one is open.

import { useCallback, useEffect, useState } from 'react'
import { manager, type WorkspaceState } from '../lib/backend'

export function useWorkspace() {
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await manager.workspace()
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

  async function save(patch: { path?: string; enabled?: boolean }) {
    setBusy(true)
    setError(null)
    try {
      const next = await manager.setWorkspace(patch)
      setState(next)
      return next
    } catch (err) {
      setError((err as Error).message)
      // The manager refused the path; show the truth rather than the draft.
      await refresh()
      return null
    } finally {
      setBusy(false)
    }
  }

  /** Only an open, existing folder counts — a stale path must not add tools. */
  const ready = Boolean(state?.enabled && state?.exists)

  return { state, ready, busy, error, save, refresh }
}
