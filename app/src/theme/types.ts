// A theme is data, not CSS. Everything the app can colour is named here;
// if a component needs a colour that isn't in this list, the list is wrong.

export type ThemeColors = {
  bg: string
  /** Content surface: the chat log. White in Win95, same as bg elsewhere. */
  field: string
  /** Behind the window. Only visible when a chrome insets the app. */
  desktop: string
  panel: string
  raised: string
  text: string
  muted: string
  faint: string
  accent: string
  onAccent: string
  border: string
  danger: string
  /** Advisory, not an error: a warning that is not a failure. */
  warn: string
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
  /**
   * Colour alone can't express a bevel. `flat` is the default; `win95` opts
   * into the chrome layer in theme/win95.css, which is scoped to
   * [data-chrome="win95"] and touches nothing else.
   */
  chrome?: 'flat' | 'win95'
  colors: ThemeColors
  fonts?: ThemeFonts
  /**
   * Base spacing multiplier, 0.5–1.5. A compact theme ships below 1, an airy
   * one above. The user's own multiplier (not built yet) will compound with it.
   */
  density?: number
  /**
   * Extra CSS custom properties for the chrome layer (bevels, title bar
   * gradient, desktop backdrop). Keys are written as `--key`. This is what
   * lets one chrome have a light and a dark variant.
   */
  chromeVars?: Record<string, string>
}
