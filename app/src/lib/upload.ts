import { toAvatarDataUrl, toResizedDataUrl } from './image'

const MANAGER = 'http://127.0.0.1:8090'

export type UploadResult = {
  url: string
  /** false when the manager was unreachable and the image stayed inline. */
  stored: boolean
}

/**
 * Resize, then hand the bytes to the manager, which writes them into the app's
 * data directory. If the manager is not running the image is kept inline as a
 * data URL, so the feature degrades instead of breaking.
 */
export async function uploadImage(
  file: File,
  kind: 'avatar' | 'attachment' = 'avatar',
): Promise<UploadResult> {
  // Avatars are square by design; attachments keep their shape.
  const dataUrl =
    kind === 'avatar' ? await toAvatarDataUrl(file, 128) : await toResizedDataUrl(file, 1024)
  const blob = await (await fetch(dataUrl)).blob()

  try {
    const res = await fetch(`${MANAGER}/api/upload?kind=${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type, 'X-Hearth': '1' },
      body: blob,
    })
    if (!res.ok) throw new Error(`upload ${res.status}`)
    const json = await res.json()
    return { url: MANAGER + json.url, stored: true }
  } catch {
    return { url: dataUrl, stored: false }
  }
}
