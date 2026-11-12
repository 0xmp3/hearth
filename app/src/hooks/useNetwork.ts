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
import { manager, type SearchHit, type SearchState } from '../lib/backend'

export function useNetwork() {
  const [enabled, setEnabled] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The provider lives beside the switch: both are egress settings, both are
  // owned by the manager, and one is meaningless without the other.
  const [search, setSearch] = useState<SearchState>({ provider: 'off', hasKey: false, searxngUrl: '' })

  const refresh = useCallback(async () => {
    try {
      const [state, searchState] = await Promise.all([manager.network(), manager.searchState()])
      setEnabled(state.enabled)
      setSearch(searchState)
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

  async function saveSearch(patch: { provider?: string; braveKey?: string; searxngUrl?: string }) {
    setBusy(true)
    setError(null)
    try {
      const next = await manager.saveSearch(patch)
      setSearch(next)
      return next
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }

  /** Runs one query, so the settings can be tried before trusting them. */
  async function testSearch(query: string): Promise<SearchHit[] | null> {
    try {
      const out = await manager.search(query, 3)
      setError(null)
      return out.results
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }

  // A provider is not a working provider. Brave without a key, or SearXNG
  // without an address, would be a tool that can only fail — the exact thing the
  // per-turn tool list exists to prevent.
  const searchReady =
    search.provider === 'brave'
      ? search.hasKey
      : search.provider === 'searxng'
        ? Boolean(search.searxngUrl.trim())
        : false

  return { enabled, available, busy, error, toggle, refresh, search, searchReady, saveSearch, testSearch }
}
