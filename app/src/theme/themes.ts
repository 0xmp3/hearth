import type { Theme } from './types'

// The default. Warm, low-contrast, built for long reading at night.
const hearth: Theme = {
  id: 'hearth',
  name: 'Hearth',
  scheme: 'dark',
  colors: {
    bg: '#14120f',
    field: '#14120f',
    desktop: '#14120f',
    panel: '#1a1714',
    raised: '#211d19',
    text: '#e9e3da',
    muted: '#8b8177',
    faint: '#5d554d',
    accent: '#c98a4b',
    onAccent: '#17130f',
    border: '#2a2521',
    danger: '#d97757',
    warn: '#d9a441',
    syntaxKeyword: '#d08b5b',
    syntaxString: '#a8b58a',
    syntaxNumber: '#c9a227',
    syntaxTitle: '#e3c9a3',
    syntaxComment: '#5d554d',
  },
}

// Same warmth, inverted. Proves the token set is complete: nothing in the
// app assumes a dark background.
const parchment: Theme = {
  id: 'parchment',
  name: 'Parchment',
  scheme: 'light',
  colors: {
    bg: '#f7f2e8',
    field: '#f7f2e8',
    desktop: '#f7f2e8',
    panel: '#efe8da',
    raised: '#e6ddcb',
    text: '#2b2620',
    muted: '#6b6156',
    faint: '#9a8f80',
    accent: '#a8622a',
    onAccent: '#fff8ef',
    border: '#dcd2c0',
    danger: '#b3402a',
    warn: '#a06a12',
    syntaxKeyword: '#a8622a',
    syntaxString: '#4f6b3a',
    syntaxNumber: '#8a6a1f',
    syntaxTitle: '#6b4a2a',
    syntaxComment: '#9a8f80',
  },
}

// Cool and quiet, for daylight.
const slate: Theme = {
  id: 'slate',
  name: 'Slate',
  scheme: 'dark',
  colors: {
    bg: '#0f1216',
    field: '#0f1216',
    desktop: '#0f1216',
    panel: '#151a20',
    raised: '#1c232b',
    text: '#dfe6ee',
    muted: '#8b98a8',
    faint: '#5c6875',
    accent: '#6ea8d8',
    onAccent: '#0b1015',
    border: '#232c36',
    danger: '#e07a5f',
    warn: '#e0b050',
    syntaxKeyword: '#7fb3e0',
    syntaxString: '#8fbf8f',
    syntaxNumber: '#d8b46a',
    syntaxTitle: '#c9d6e4',
    syntaxComment: '#5c6875',
  },
}

// The easter egg. Win95 chrome, vaporwave palette: a violet desktop, a
// lilac-grey window face, and a title bar that runs violet into hot pink.
const win95: Theme = {
  id: 'win95',
  name: 'Hearth 98',
  scheme: 'light',
  chrome: 'win95',
  colors: {
    bg: '#c9c4d6',
    field: '#ffffff',
    desktop: '#1b0b2e',
    panel: '#c9c4d6',
    raised: '#d9d4e6',
    text: '#1a1a2e',
    muted: '#4a4460',
    faint: '#7a7490',
    accent: '#ff2e88',
    onAccent: '#ffffff',
    border: '#8a84a0',
    danger: '#c02020',
    warn: '#a06a12',
    syntaxKeyword: '#000080',
    syntaxString: '#007a3d',
    syntaxNumber: '#8a1a1a',
    syntaxTitle: '#6a0dad',
    syntaxComment: '#7a7490',
  },
  fonts: {
    sans: 'Tahoma, "MS Sans Serif", "Segoe UI", sans-serif',
    mono: '"Lucida Console", "Cascadia Mono", Consolas, monospace',
    display: 'Tahoma, "MS Sans Serif", sans-serif',
  },
  chromeVars: {
    'bevel-hi': '#ffffff',
    'bevel-lo': '#6b6580',
    'bevel-edge': '#3d3850',
    'title-a': '#2a0845',
    'title-b': '#ff2e88',
    'desktop-a': '#2a0845',
    'desktop-b': '#12071f',
  },
}

// The same window after dark. Bevels invert: the highlight is a lighter grey
// and the shadow goes near-black, which is the whole trick to a dark bevel.
const win95dark: Theme = {
  id: 'win95dark',
  name: 'Hearth 98 Dark',
  scheme: 'dark',
  chrome: 'win95',
  colors: {
    bg: '#2a2636',
    field: '#1a1722',
    desktop: '#0a0710',
    panel: '#2a2636',
    raised: '#35303f',
    text: '#e8e4f0',
    muted: '#a09ab0',
    faint: '#6b6580',
    accent: '#ff2e88',
    onAccent: '#ffffff',
    border: '#4a4460',
    danger: '#ff6b6b',
    warn: '#ffcc44',
    syntaxKeyword: '#7fb3e0',
    syntaxString: '#8fbf8f',
    syntaxNumber: '#d8b46a',
    syntaxTitle: '#c9a0ff',
    syntaxComment: '#6b6580',
  },
  fonts: {
    sans: 'Tahoma, "MS Sans Serif", "Segoe UI", sans-serif',
    mono: '"Lucida Console", "Cascadia Mono", Consolas, monospace',
    display: 'Tahoma, "MS Sans Serif", sans-serif',
  },
  chromeVars: {
    'bevel-hi': '#5f5878',
    'bevel-lo': '#050409',
    'bevel-edge': '#000000',
    'title-a': '#0d0518',
    'title-b': '#01cdfe',
    'desktop-a': '#0a0710',
    'desktop-b': '#1a0b2e',
  },
}

export const themes: Record<string, Theme> = { hearth, parchment, slate, win95, win95dark }

export const DEFAULT_THEME = 'hearth'
