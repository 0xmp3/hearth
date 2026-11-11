// App preferences that are not per-conversation. Kept in localStorage:
// they are settings, not data, and a broken read must never break the app.

import { useState } from 'react'

const KEY = 'hearth.prefs'

type Prefs = {
  showReasoning: boolean
}

const DEFAULTS: Prefs = { showReasoning: true }

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return DEFAULTS
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load)

  function update(patch: Partial<Prefs>) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // preference only; not fatal
      }
      return next
    })
  }

  return { prefs, update }
}
