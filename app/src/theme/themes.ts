import type { Theme } from './types'

// The default. Warm, low-contrast, built for long reading at night.
const hearth: Theme = {
  id: 'hearth',
  name: 'Hearth',
  scheme: 'dark',
  colors: {
    bg: '#14120f',
    panel: '#1a1714',
    raised: '#211d19',
    text: '#e9e3da',
    muted: '#8b8177',
    faint: '#5d554d',
    accent: '#c98a4b',
    onAccent: '#17130f',
    border: '#2a2521',
    danger: '#d97757',
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
    panel: '#efe8da',
    raised: '#e6ddcb',
    text: '#2b2620',
    muted: '#6b6156',
    faint: '#9a8f80',
    accent: '#a8622a',
    onAccent: '#fff8ef',
    border: '#dcd2c0',
    danger: '#b3402a',
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
    panel: '#151a20',
    raised: '#1c232b',
    text: '#dfe6ee',
    muted: '#8b98a8',
    faint: '#5c6875',
    accent: '#6ea8d8',
    onAccent: '#0b1015',
    border: '#232c36',
    danger: '#e07a5f',
    syntaxKeyword: '#7fb3e0',
    syntaxString: '#8fbf8f',
    syntaxNumber: '#d8b46a',
    syntaxTitle: '#c9d6e4',
    syntaxComment: '#5c6875',
  },
}

export const themes: Record<string, Theme> = { hearth, parchment, slate }

export const DEFAULT_THEME = 'hearth'
