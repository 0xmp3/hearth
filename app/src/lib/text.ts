// Text tidying, at render time only.
//
// The stored message is left exactly as the model wrote it; only the rendered
// body is cleaned. Two separate faults made this necessary, and they are worth
// knowing before "simplifying" either one:
//
//   * **`white-space: pre-wrap` doubles every paragraph break.** ReactMarkdown
//     emits newline text nodes between blocks, and pre-wrap renders those *and*
//     the block spacing, so one blank line on screen looked like five while the
//     stored text was correct. The stored string is never the bug.
//   * **Tool rounds pad.** Every round of a turn adds its own separator, so three
//     or more newlines is always noise rather than intent.
//
// Fenced code is left exactly as written: a collapsed blank line inside code
// changes what the user copies.

export function tidy(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/\n{3,}/g, '\n\n')))
    .join('')
}
