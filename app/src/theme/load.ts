// Themes that live in files.
//
// The manager reads `data/themes/*.json` and hands back the parsed contents;
// this module validates them and merges them over the built-ins. A file theme
// with the same id as a built-in replaces it, which is how you fork a shipped
// theme without editing the source.
//
// If the manager is not running the app simply has the built-ins — a missing
// manager is not an error, it is the normal case for someone who starts the
// server themselves.

import { validateTheme } from './validate'
import type { Theme } from './types'

const MANAGER = 'http://127.0.0.1:8090'

export type ThemeProblem = { file: string; reason: string }

export type LoadedThemes = {
  themes: Record<string, Theme>
  problems: ThemeProblem[]
}

type ManagerResponse = {
  files?: { name: string; data: unknown }[]
  problems?: ThemeProblem[]
}

export async function loadFileThemes(): Promise<LoadedThemes> {
  const themes: Record<string, Theme> = {}
  const problems: ThemeProblem[] = []

  let payload: ManagerResponse
  try {
    const res = await fetch(`${MANAGER}/api/themes`, { headers: { 'X-Hearth': '1' } })
    if (!res.ok) return { themes, problems }
    payload = await res.json()
  } catch {
    return { themes, problems }
  }

  // Files the manager could not even parse.
  for (const p of payload.problems ?? []) problems.push(p)

  for (const file of payload.files ?? []) {
    const result = validateTheme(file.data)
    if (result.ok) themes[result.theme.id] = result.theme
    else problems.push({ file: file.name, reason: result.reason })
  }

  return { themes, problems }
}
