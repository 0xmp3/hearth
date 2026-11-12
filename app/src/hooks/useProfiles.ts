// Profiles are who *you* are — the counterpart to characters, which are who the
// model is. One is active app-wide; a conversation can override it or opt out.
//
// This replaces the name-and-avatar pair that used to live in preferences. The
// first run seeds a profile from those old values so nobody loses their name.

import { useEffect, useState } from 'react'
import * as db from '../lib/db'

const ACTIVE_KEY = 'hearth.profile'

/**
 * A fixed id makes the seed idempotent. React's StrictMode mounts effects
 * twice in development, and two mounts racing on "is the store empty?" will
 * both answer yes — with a fixed id they write the same record instead of
 * creating two profiles called "User".
 */
const SEED_ID = 'profile-default'

export type ProfileSeed = { name?: string; avatar?: string }

export function useProfiles(seed: ProfileSeed) {
  const [profiles, setProfiles] = useState<db.Profile[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_KEY)
    } catch {
      return null
    }
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let list = await db.listProfiles()

      // One-time seed. Only runs when the store is empty, so renaming a profile
      // never resurrects the old preference.
      if (!list.length && seed.name?.trim()) {
        const first: db.Profile = {
          id: SEED_ID,
          name: seed.name.trim(),
          avatar: seed.avatar,
          createdAt: Date.now(),
        }
        await db.putProfile(first)
        list = await db.listProfiles()
      }

      if (cancelled) return
      setProfiles(list)
      setActiveId((current) => current ?? list[0]?.id ?? null)
    })()
    return () => {
      cancelled = true
    }
    // Seeded once, on mount. Later changes to preferences must not re-seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null

  /**
   * Which profile a conversation speaks as.
   * `undefined` inherits the app-wide active profile, `null` means none.
   */
  function resolve(profileId: string | null | undefined): db.Profile | null {
    if (profileId === null) return null
    if (profileId === undefined) return active
    return profiles.find((p) => p.id === profileId) ?? null
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

  async function save(profile: db.Profile) {
    await db.putProfile(profile)
    setProfiles((prev) => {
      const exists = prev.some((p) => p.id === profile.id)
      return exists ? prev.map((p) => (p.id === profile.id ? profile : p)) : [...prev, profile]
    })
  }

  async function remove(id: string) {
    await db.deleteProfile(id)
    setProfiles((prev) => prev.filter((p) => p.id !== id))
    if (activeId === id) select(null)
  }

  return { profiles, active, activeId, select, save, remove, resolve }
}
