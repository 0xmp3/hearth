// Characters are app-level, not conversation-level: one is active at a time and
// its prompt is prepended to whatever the conversation already says.

import { useEffect, useState } from 'react'
import * as db from '../lib/db'

const ACTIVE_KEY = 'hearth.character'

export function useCharacters() {
  const [characters, setCharacters] = useState<db.Character[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_KEY)
    } catch {
      return null
    }
  })

  useEffect(() => {
    void db.listCharacters().then(setCharacters)
  }, [])

  const active = characters.find((p) => p.id === activeId) ?? null

  /**
   * Which character a conversation speaks as.
   * `undefined` inherits the globally active profile (older conversations),
   * `null` means explicitly none, a string picks that profile.
   */
  function resolve(characterId: string | null | undefined): db.Character | null {
    if (characterId === null) return null
    if (characterId === undefined) return active
    return characters.find((p) => p.id === characterId) ?? null
  }

  function select(id: string | null) {
    setActiveId(id)
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id)
      else localStorage.removeItem(ACTIVE_KEY)
    } catch {
      // preference only; not fatal
    }
  }

  async function save(character: db.Character) {
    await db.putCharacter(character)
    setCharacters((prev) => {
      const exists = prev.some((p) => p.id === character.id)
      return exists ? prev.map((p) => (p.id === character.id ? character : p)) : [...prev, character]
    })
  }

  async function remove(id: string) {
    await db.deleteCharacter(id)
    setCharacters((prev) => prev.filter((p) => p.id !== id))
    if (activeId === id) select(null)
  }

  return { characters, active, activeId, select, save, remove, resolve }
}
