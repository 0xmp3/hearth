import { makeBackup, type Backup, type Conversation, type Message } from './db'

export function toMarkdown(conv: Conversation, messages: Message[]): string {
  const out: string[] = [
    `# ${conv.title}`,
    '',
    `_${new Date(conv.createdAt).toLocaleString()} · ${conv.model}_`,
    '',
  ]

  if (conv.systemPrompt?.trim()) {
    out.push('> **System prompt**', '>')
    for (const line of conv.systemPrompt.trim().split('\n')) out.push(`> ${line}`)
    out.push('')
  }

  for (const m of messages) {
    out.push(m.role === 'user' ? '## You' : '## Assistant', '')
    if (m.reasoning) {
      out.push('<details><summary>thinking</summary>', '', m.reasoning, '', '</details>', '')
    }
    out.push(m.content, '')
  }

  return out.join('\n')
}

// Same envelope as a full backup, with one conversation in it. That is what
// makes a single chat restorable through the same import path.
export function toJson(conv: Conversation, messages: Message[]): string {
  return JSON.stringify(makeBackup([conv], messages), null, 2)
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'conversation'
  )
}

// Validate before touching the database: a half-parsed backup that writes
// garbage into IndexedDB is worse than a refused import.
export function parseBackup(text: string): Backup {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('that file is not valid JSON')
  }

  if (data?.format !== 'hearth-backup') throw new Error('that is not a Hearth backup file')
  if (data.version !== 1) throw new Error(`unsupported backup version: ${data.version}`)
  if (!Array.isArray(data.conversations) || !Array.isArray(data.messages)) {
    throw new Error('backup is missing conversations or messages')
  }

  for (const c of data.conversations) {
    if (!c?.id || typeof c.title !== 'string') throw new Error('a conversation in the backup is malformed')
  }
  for (const m of data.messages) {
    if (!m?.id || !m.conversationId || typeof m.content !== 'string') {
      throw new Error('a message in the backup is malformed')
    }
  }

  return data as Backup
}

export function backupFilename(): string {
  return `hearth-backup-${new Date().toISOString().slice(0, 10)}.json`
}

export function download(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
