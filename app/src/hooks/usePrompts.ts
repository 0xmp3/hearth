// A library of reusable system prompts. Applying one copies its text into the
// conversation — the library is a shortcut, not a live binding, so editing a
// prompt later never rewrites history in an existing chat.

import { useEffect, useState } from 'react'
import * as db from '../lib/db'

export function usePrompts() {
  const [prompts, setPrompts] = useState<db.Prompt[]>([])

  useEffect(() => {
    void db.listPrompts().then(setPrompts)
  }, [])

  async function save(prompt: db.Prompt) {
    await db.putPrompt(prompt)
    setPrompts((prev) => {
      const exists = prev.some((p) => p.id === prompt.id)
      const next = exists ? prev.map((p) => (p.id === prompt.id ? prompt : p)) : [...prev, prompt]
      return next.sort((a, b) => a.name.localeCompare(b.name))
    })
  }

  async function remove(id: string) {
    await db.deletePrompt(id)
    setPrompts((prev) => prev.filter((p) => p.id !== id))
  }

  return { prompts, save, remove }
}
