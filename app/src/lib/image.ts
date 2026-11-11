// Downscale to fit inside a box, keeping the aspect ratio. Attachments use
// this: cropping a document to a square silently deletes its edges, which is
// how a sign reading "BANANA 42" arrives as "ANANA 4".
export async function toResizedDataUrl(file: File, maxSize = 1024): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()

  return canvas.toDataURL('image/jpeg', 0.9)
}

// Avatars are stored as data URLs, so they must be small. Crop to a square and
// downscale before they ever touch storage.
export async function toAvatarDataUrl(file: File, size = 128): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')

  const scale = Math.max(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  bitmap.close?.()

  return canvas.toDataURL('image/jpeg', 0.85)
}
