// What day it is.
//
// A model has no clock. Asked about 2026 it reasons from its training data —
// "it's currently 2024 or early 2025, based on typical training data" — and
// concludes the question is about the future. That reasoning is sound given what
// it knows; the fix is to give it something it does not have, not to argue.
//
// Two things matter and only one of them is the date:
//
//   * the date itself, unambiguous;
//   * permission to prefer it over the model's own sense of "now". Without that
//     sentence the model can read the date and still write "assuming we are in
//     2025". Worth the extra line.
//
// Deliberately day-granularity, and deliberately *not* the clock time. The
// system prompt is the cached prefix of every request: a value that changes per
// request turns llama.cpp's prompt cache into a permanent miss, which shows up
// as a slow first token on every turn. A date changes once a day. If a
// conversation ever needs the exact time, that is a tool call, not a prompt
// field.

/** The day, the way a person would say it, plus ISO and the timezone. */
export function currentDateBlock(now: Date = new Date()): string {
  const human = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now)

  // Built from local parts, not toISOString: that one is UTC, so at 9am in
  // Sydney it would name yesterday.
  const iso = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
  const offset = -now.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const mm = String(Math.abs(offset) % 60).padStart(2, '0')
  const utc = `UTC${sign}${hh}:${mm}`

  return (
    `Today is ${human} (${iso}), in ${zone} (${utc}). ` +
    'That is the real current date and this system has a working clock: your training data ' +
    'ends earlier, so when the two disagree about what year it is, this line is right. ' +
    'The time of day is not provided, so do not guess one.'
  )
}
