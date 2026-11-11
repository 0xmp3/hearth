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
