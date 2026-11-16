// What the loaded model can actually accept.
//
// llama-server reports this at /props, and it is the difference between an
// image being understood and an image being silently dropped — a model without
// a vision projector answers an image with an empty reply, which looks like a
// bug rather than a missing capability.

import { BASE_URL } from './config'
import { listModels } from './models'

const cache = new Map<string, boolean>()

export async function supportsVision(model: string): Promise<boolean> {
  if (!model) return false
  const hit = cache.get(model)
  if (hit !== undefined) return hit

  // The model list is the better source when the backend states it: some
  // backends publish `architecture.input_modalities`, and llama.cpp does not.
  try {
    const info = (await listModels(BASE_URL)).find((m) => m.id === model)
    if (info?.vision !== undefined) {
      cache.set(model, info.vision)
      return info.vision
    }
  } catch {
    // fall through to /props
  }

  try {
    const res = await fetch(`${BASE_URL}/props?model=${encodeURIComponent(model)}`)
    if (!res.ok) return false
    const data = await res.json()
    const vision = Boolean(data?.modalities?.vision)
    cache.set(model, vision)
    return vision
  } catch {
    return false
  }
}
