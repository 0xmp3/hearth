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
}
