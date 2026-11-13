// What day it is, and how the model finds out.
//
// A model has no clock. Asked about 2026 it reasons from its training data —
// "it's currently 2024 or early 2025, based on typical training data" — and
// concludes the question is about the future. That reasoning is sound given what
// it knows; the fix is to give it something it does not have.
//
// Two surfaces, because one was not enough:
//
//   currentDateBlock() goes in the system prompt. Cheap, always present, and
//   enough for most models. But it is a *claim*, and a claim inside a roleplay
//   or "simulated environment" frame is dismissible — gemma answered exactly
//   that way: "as an AI, I can't actually browse the real 2026 internet… in this
//   persona/simulated environment". A model that has decided the setting is
//   fictional can file the date under fiction too.
//
//   clockReading() is what the `now` tool returns, and it is a different kind of
//   thing: a value produced by the host machine's clock at the moment the model
//   asked for it. That is an observation the model watched itself make, not an
//   assertion somebody put in its prompt, and models weigh it accordingly.
//
// The date block is day-granularity on purpose — it is the cached prefix of
// every request, so a per-request value would make llama.cpp's prompt cache a
// permanent miss. The tool has no such constraint: it is called deliberately and
// its result lands in history, after the prefix.

function parts(now: Date) {
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

  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)

  return { human, iso, zone, utc: `UTC${sign}${hh}:${mm}`, clock }
}

/** The system-prompt line. Day granularity, so the prompt cache survives. */
export function currentDateBlock(now: Date = new Date()): string {
  const { human, iso, zone, utc } = parts(now)
  return (
    `Today is ${human} (${iso}), in ${zone} (${utc}). ` +
    'That is the real current date and this system has a working clock: your training data ' +
    'ends earlier, so when the two disagree about what year it is, this line is right. ' +
    'If you are unsure, call the now tool and read its result. The exact time of day is not ' +
    'given here, so do not guess one.'
  )
}

/** What the `now` tool returns: the full reading, including the clock. */
export function clockReading(now: Date = new Date()): string {
  const { human, iso, zone, utc, clock } = parts(now)
  return (
    `It is ${human}, ${clock}, in ${zone} (${utc}). ISO date: ${iso}.\n` +
    'Read from the system clock of the machine running this app, at the moment of this call. ' +
    'Your training data ends before this date, so anything you remember about "the current year" ' +
    'is out of date — use this reading instead, and treat it as fact rather than as context.'
  )
}
