import type { Conversation, Message } from './db'

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

export function toJson(conv: Conversation, messages: Message[]): string {
  return JSON.stringify({ conversation: conv, messages }, null, 2)
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
