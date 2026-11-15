// App preferences that are not per-conversation.
//
// These used to live only in localStorage, which meant "clear cookies and site
// data" reset the theme, your name, the reply budget and the layout. They are
// settings, not data, but losing them is still losing something you chose.
//
// So the copy on disk is the truth and localStorage is a **cache**: the first
// paint reads the cache synchronously (no flash of defaults), then the manager's
// copy arrives and wins. A manager that is not running leaves the cache in place,
// which is the right failure — the app still opens with your settings.

import { useEffect, useState } from 'react'
import { getMeta, setMeta } from '../lib/db'
import type { EffortMode, TextStyle } from '../lib/db'
import type { ToolName } from '../lib/tools'

const KEY = 'hearth.prefs'
const META = 'prefs'

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
  /** Show the system metrics strip in the sidebar. Off by default. */
  showMetrics: boolean
  sidebarCollapsed: boolean
  /** 'sidebar' = conversations down the left, 'tabs' = across the top. */
  layout: 'sidebar' | 'tabs'
  /** Speak every reply as it finishes. Off until the user asks for it. */
  autoSpeak: boolean
  /** Voice id for characters that do not pin one. */
  speechVoice: string
  /** Width of the page preview panel, in px. Remembered across sessions. */
  previewWidth: number
  /**
   * Whether animated text may move.
   *
   * `system` follows `prefers-reduced-motion`, which on Windows is the
   * "Animation effects" switch and is off on a lot of performance-tuned
   * machines. That default is right — but it is a system-wide setting, not a
   * decision about this app, so it can be overridden deliberately here.
   */
  motion: 'system' | 'on' | 'off'
  /**
   * Which tools the app may offer at all.
   *
   * This is the outer bound, and it is global on purpose: a conversation can
   * narrow it, never widen it. A tool that is off here is never declared to the
   * model, which is the only honest way to say "you cannot do this" — a tool
   * that exists and fails teaches the model to promise it.
   */
  tools: Record<ToolName, boolean>
  /** Default reasoning effort. A conversation can override it. */
  effort: EffortMode
  /** Default emphasis style. A conversation can override it. */
  style: TextStyle
}

const DEFAULTS: Prefs = {
  showReasoning: true,
  userName: 'User',
  maxTokens: 2048,
  userAvatar: '',
  assistantName: 'Hearth',
  assistantAvatar: '',
  sidebarCollapsible: true,
  showMetrics: false,
  sidebarCollapsed: false,
  layout: 'sidebar',
  autoSpeak: false,
  speechVoice: '',
  previewWidth: 480,
  motion: 'system',
  // Everything on, which is what "Everything available" meant before this page
  // existed. The manager's own switches (workspace, network) stay the outer gate,
  // so a tool being on here does not mean it can reach anything.
  tools: {
    remember: true,
    search_history: true,
    web_read: true,
    web_search: true,
    list_files: true,
    search_files: true,
    read_file: true,
  },
  effort: 'default',
  style: 'off',
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

function cache(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // A preference that cannot be cached is not fatal: the disk copy is the one
    // that matters.
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load)

  // The disk copy wins once it arrives. Merged over the cache rather than
  // replacing it, so a preference added in a later version keeps its default
  // instead of vanishing.
  useEffect(() => {
    let cancelled = false
    void getMeta<Partial<Prefs>>(META)
      .then((disk) => {
        if (cancelled || !disk) return
        setPrefs((current) => {
          const next = { ...current, ...disk }
          cache(next)
          return next
        })
      })
      .catch(() => {
        // No manager: the cache is all there is, and it is already loaded.
      })
    return () => {
      cancelled = true
    }
  }, [])

  function update(patch: Partial<Prefs>) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      cache(next)
      void setMeta(META, next).catch(() => {})
      return next
    })
  }

  return { prefs, update }
}
