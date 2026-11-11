// Personas are app-level, not conversation-level: one is active at a time and
// its prompt is prepended to whatever the conversation already says.

import { useEffect, useState } from 'react'
import * as db from '../lib/db'

const ACTIVE_KEY = 'hearth.persona'

export function usePersonas() {
  const [personas, setPersonas] = useState<db.Persona[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_KEY)
    } catch {
      return null
    }
  })

  useEffect(() => {
    void db.listPersonas().then(setPersonas)
  }, [])

  const active = personas.find((p) => p.id === activeId) ?? null

  function select(id: string | null) {
    setActiveId(id)
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id)
      else localStorage.removeItem(ACTIVE_KEY)
    } catch {
      // preference only; not fatal
    }
  }

  async function save(persona: db.Persona) {
    await db.putPersona(persona)
    setPersonas((prev) => {
      const exists = prev.some((p) => p.id === persona.id)
      return exists ? prev.map((p) => (p.id === persona.id ? persona : p)) : [...prev, persona]
    })
  }

  async function remove(id: string) {
    await db.deletePersona(id)
    setPersonas((prev) => prev.filter((p) => p.id !== id))
    if (activeId === id) select(null)
  }

  return { personas, active, activeId, select, save, remove }
}
