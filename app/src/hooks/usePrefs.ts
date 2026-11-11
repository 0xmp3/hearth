// App preferences that are not per-conversation. Kept in localStorage:
// they are settings, not data, and a broken read must never break the app.

import { useState } from 'react'

const KEY = 'hearth.prefs'

type Prefs = {
  showReasoning: boolean
  /** Shown on your own messages. Initials only — no image pipeline yet. */
  userName: string
  /** Reply budget. Reasoning models can spend all of it thinking. */
  maxTokens: number
  /** Data URL or manager URL, or empty for initials. */
  userAvatar: string
  /** The model's own identity, used when no profile is active. */
  assistantName: string
  assistantAvatar: string
  /** Whether the sidebar can be collapsed at all. */
  sidebarCollapsible: boolean
  sidebarCollapsed: boolean
  /** 'sidebar' = conversations down the left, 'tabs' = across the top. */
  layout: 'sidebar' | 'tabs'
}

const DEFAULTS: Prefs = {
  showReasoning: true,
  userName: 'User',
  maxTokens: 2048,
  userAvatar: '',
  assistantName: 'Hearth',
  assistantAvatar: '',
  sidebarCollapsible: true,
  sidebarCollapsed: false,
  layout: 'sidebar',
}

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
