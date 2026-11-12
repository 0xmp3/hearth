// Whether this app may reach the internet, and what it did when it did.
//
// Two separate facts, deliberately kept apart:
//
//   available — the manager is running, so a fetch is even possible
//   enabled   — the user has switched egress on
//
// The manager stores `enabled` in data/config.json and enforces it there, so a
// stale tab cannot talk itself into egress. This hook is the app's view of that
// answer, not the answer itself.

import { useCallback, useEffect, useState } from 'react'
import { manager } from '../lib/backend'

export function useNetwork() {
  const [enabled, setEnabled] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const state = await manager.network()
      setEnabled(state.enabled)
      setAvailable(true)
      setError(null)
      return state.enabled
    } catch {
      // No manager means no egress — which is the safe direction to fail.
      setAvailable(false)
      setEnabled(false)
      return false
    }
  }, [])

  useEffect(() => {
    void refresh()
    // The manager owns the switch, and it can be changed from another tab or by
    // editing the config. Re-reading on focus keeps this copy from claiming an
    // egress that no longer exists.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  async function toggle(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      const state = await manager.setNetwork(next)
      setEnabled(state.enabled)
      setAvailable(true)
      return state.enabled
    } catch (err) {
      setError((err as Error).message)
      // Read back rather than assume: the manager is the owner of this switch.
      await refresh()
      return false
    } finally {
      setBusy(false)
    }
  }

  return { enabled, available, busy, error, toggle, refresh }
}
