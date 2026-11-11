// A theme is data, not CSS. Everything the app can colour is named here;
// if a component needs a colour that isn't in this list, the list is wrong.

export type ThemeColors = {
  bg: string
  panel: string
  raised: string
  text: string
  muted: string
  faint: string
  accent: string
  onAccent: string
  border: string
  danger: string
  syntaxKeyword: string
  syntaxString: string
  syntaxNumber: string
  syntaxTitle: string
  syntaxComment: string
}

export type ThemeFonts = {
  sans?: string
  mono?: string
  display?: string
}

export type Theme = {
  id: string
  name: string
  /** Drives native widgets: scrollbars, form controls, caret. */
  scheme: 'dark' | 'light'
  colors: ThemeColors
  fonts?: ThemeFonts
}
