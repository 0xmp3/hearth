import { useEffect, useState } from 'react'
import { themes, DEFAULT_THEME } from './themes'
import type { Theme } from './types'

const STORAGE_KEY = 'hearth.theme'

// camelCase token -> --kebab-case custom property
function cssVar(key: string): string {
  return '--' + key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(cssVar(key), value)
  }
  root.style.setProperty('color-scheme', theme.scheme)
  root.setAttribute('data-chrome', theme.chrome ?? 'flat')

  // Fonts are optional: a theme that omits them inherits the stylesheet default.
  for (const [key, value] of Object.entries(theme.fonts ?? {})) {
    if (value) root.style.setProperty('--font-' + key, value)
  }
}

export function loadTheme(): Theme {
  try {
    const id = localStorage.getItem(STORAGE_KEY)
    if (id && themes[id]) return themes[id]
  } catch {
    // private mode / storage disabled — fall through to the default
  }
  return themes[DEFAULT_THEME]
}

export function useTheme() {
  const [themeId, setThemeId] = useState<string>(() => loadTheme().id)
  const theme = themes[themeId] ?? themes[DEFAULT_THEME]

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme.id)
    } catch {
      // not fatal: the theme still applies for this session
    }
  }, [theme])

  return {
    theme,
    themeId: theme.id,
    setTheme: setThemeId,
    available: Object.values(themes),
  }
}
