import { useEffect, useState } from 'react'
import { themes, DEFAULT_THEME } from './themes'
import { loadFileThemes, type ThemeProblem } from './load'
import type { Theme } from './types'

const STORAGE_KEY = 'hearth.theme'
// The last applied theme, verbatim. A file theme is not available until the
// manager answers, so without this the app would boot in the default and then
// visibly switch. The cache makes the first paint correct.
const CACHE_KEY = 'hearth.theme.cache'

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
  // A theme's base density. The user multiplier will compound with this later.
  root.style.setProperty('--density', String(theme.density ?? 1))
  root.setAttribute('data-chrome', theme.chrome ?? 'flat')

  // Fonts are optional: a theme that omits them inherits the stylesheet default.
  for (const [key, value] of Object.entries(theme.fonts ?? {})) {
    if (value) root.style.setProperty('--font-' + key, value)
  }

  for (const [key, value] of Object.entries(theme.chromeVars ?? {})) {
    root.style.setProperty('--' + key, value)
  }

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(theme))
  } catch {
    // not fatal: the theme still applies for this session
  }
}

function savedThemeId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** The theme to paint before React mounts. */
export function loadTheme(): Theme {
  const id = savedThemeId()
  if (id) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null')
      if (cached && cached.id === id) return cached as Theme
    } catch {
      // fall through to the built-ins
    }
    if (themes[id]) return themes[id]
  }
  return themes[DEFAULT_THEME]
}

export function useTheme() {
  const [registry, setRegistry] = useState<Record<string, Theme>>(themes)
  const [problems, setProblems] = useState<ThemeProblem[]>([])
  const [themeId, setThemeId] = useState<string>(() => loadTheme().id)

  useEffect(() => {
    let cancelled = false
    void loadFileThemes().then(({ themes: fromFiles, problems }) => {
      if (cancelled) return
      // A file theme with a built-in's id replaces it: that is how you fork a
      // shipped theme without editing the source.
      setRegistry({ ...themes, ...fromFiles })
      setProblems(problems)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const theme = registry[themeId] ?? registry[DEFAULT_THEME]

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
    available: Object.values(registry),
    problems,
  }
}
