// Reading a folder from a browser needs the File System Access API: a path
// string is useless, a directory handle is not. The handle is structured-
// cloneable, so it survives in IndexedDB — but permission must be re-granted
// after a reload, which is why every read goes through ensurePermission.

import { getMeta, setMeta } from './db'

const HANDLE_KEY = 'modelsDir'
const NOTES_KEY = 'modelNotes'

export type ModelFile = {
  name: string
  size: number
  quant?: string
  params?: string
  experts?: string
}

export function supported(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function'
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!supported()) return null
  const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ mode: 'read' })
  await setMeta(HANDLE_KEY, handle)
  return handle
}

export async function savedDirectory(): Promise<FileSystemDirectoryHandle | null> {
  return (await getMeta<FileSystemDirectoryHandle>(HANDLE_KEY)) ?? null
}

export async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  // queryPermission/requestPermission are in the File System Access spec but
  // not in TypeScript's DOM lib yet.
  const h = handle as any
  const opts = { mode: 'read' as const }
  if ((await h.queryPermission(opts)) === 'granted') return true
  return (await h.requestPermission(opts)) === 'granted'
}

// Quant and size are usually in the filename; that is all we can know without
// parsing the GGUF header, which is a separate job.
export function describeName(name: string): Pick<ModelFile, 'quant' | 'params' | 'experts'> {
  const quant = name.match(/\b(I?Q\d+(_[A-Z0-9]+)*|F16|BF16|F32)\b/i)?.[0]
  const experts = name.match(/\bA(\d+(?:\.\d+)?B)\b/i)?.[0]
  // "26B", "300m", or Gemma's "E4B" style.
  const params =
    name.match(/\b(\d+(?:\.\d+)?[BMbm])\b/)?.[0] ??
    name.match(/\bE(\d+(?:\.\d+)?B)\b/i)?.[0]
  return { quant, params, experts }
}

export async function listModels(handle: FileSystemDirectoryHandle): Promise<ModelFile[]> {
  const out: ModelFile[] = []
  for await (const [name, entry] of (handle as any).entries()) {
    if (entry.kind !== 'file' || !name.toLowerCase().endsWith('.gguf')) continue
    const file = await entry.getFile()
    out.push({ name, size: file.size, ...describeName(name) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadNotes(): Promise<Record<string, string>> {
  return (await getMeta<Record<string, string>>(NOTES_KEY)) ?? {}
}

export async function saveNote(name: string, text: string): Promise<Record<string, string>> {
  const notes = await loadNotes()
  if (text.trim()) notes[name] = text.trim()
  else delete notes[name]
  await setMeta(NOTES_KEY, notes)
  return notes
}

export function formatSize(bytes: number): string {
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}
