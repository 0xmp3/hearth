import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import Composer from './components/Composer'
import Palette, { type PaletteAction } from './components/Palette'
import { useHearth } from './hooks/useHearth'
import { useTheme } from './theme/apply'
import { exportAll, importAll, searchMessages } from './lib/db'
import { backupFilename, download, parseBackup, slug, toJson, toMarkdown } from './lib/export'

export default function App() {
  const h = useHearth()
  const t = useTheme()
  const [showSystem, setShowSystem] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [sysDraft, setSysDraft] = useState('')
  const sysRef = useRef('')
  const sysTimer = useRef<number | null>(null)

  // Keep the draft in step with whichever conversation is open.
  useEffect(() => {
    const value = h.activeConversation?.systemPrompt ?? ''
    setSysDraft(value)
    sysRef.current = value
  }, [h.activeConversation?.id])

  // Save on a debounce rather than on blur: a blur handler closes over the
  // draft from its render, so pasting and clicking away in one tick saved ''.
  function onSystemChange(text: string) {
    sysRef.current = text
    setSysDraft(text)
    if (sysTimer.current !== null) clearTimeout(sysTimer.current)
    sysTimer.current = window.setTimeout(() => {
      sysTimer.current = null
      h.setSystemPrompt(text)
    }, 400)
  }

  // Window title follows the conversation.
  useEffect(() => {
    document.title = h.activeConversation?.title
      ? `${h.activeConversation.title} — Hearth`
      : 'Hearth'
  }, [h.activeConversation?.title])

  // Ctrl/Cmd+K palette, Esc closes it or stops a reply.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (e.key === 'Escape') {
        if (paletteOpen) {
          setPaletteOpen(false)
          return
        }
        if (h.streaming) h.stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, h.streaming, h.stop])

  function exportMarkdown() {
    const conv = h.activeConversation
    if (!conv) return
    download(`${slug(conv.title)}.md`, toMarkdown(conv, h.messages), 'text/markdown')
  }

  function exportJson() {
    const conv = h.activeConversation
    if (!conv) return
    download(`${slug(conv.title)}.json`, toJson(conv, h.messages), 'application/json')
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  async function backupAll() {
    const backup = await exportAll()
    download(backupFilename(), JSON.stringify(backup, null, 2), 'application/json')
    setNotice(`Backed up ${plural(backup.conversations.length, 'conversation')}, ${plural(backup.messages.length, 'message')}.`)
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const backup = parseBackup(await file.text())
      const result = await importAll(backup)
      await h.reload()
      setNotice(`Restored ${plural(result.conversations, 'conversation')}, ${plural(result.messages, 'message')}.`)
    } catch (err) {
      setNotice(`Import failed: ${(err as Error).message}`)
    }
  }

  const actions: PaletteAction[] = [
    { id: 'new', label: 'New conversation', run: () => void h.create() },
    ...(h.activeConversation
      ? [
          { id: 'export-md', label: 'Export this conversation as Markdown', run: exportMarkdown },
          { id: 'export-json', label: 'Export this conversation as JSON', hint: 'restorable', run: exportJson },
        ]
      : []),
    { id: 'backup', label: 'Back up all conversations', hint: 'json', run: () => void backupAll() },
    { id: 'restore', label: 'Restore from file…', hint: 'backup or single chat', run: () => fileRef.current?.click() },
    { id: 'system', label: 'Toggle system prompt', run: () => setShowSystem((v) => !v) },
    ...(h.streaming ? [{ id: 'stop', label: 'Stop generating', run: h.stop }] : []),
  ]

  function flushSystem() {
    if (sysTimer.current !== null) {
      clearTimeout(sysTimer.current)
      sysTimer.current = null
    }
    h.setSystemPrompt(sysRef.current)
  }

  return (
    <div className="app">
      {/* Decorative. Only the win95 chrome displays this. */}
      <div className="titlebar" aria-hidden="true">
        <span className="titlebar-text">hearth.exe</span>
        <div className="win-buttons">
          <span>_</span>
          <span>□</span>
          <span>×</span>
        </div>
      </div>

      <div className="app-body">
        <Sidebar
          conversations={h.conversations}
          activeId={h.activeId}
          disabled={h.streaming}
          onSelect={h.select}
          onCreate={h.create}
          onDelete={h.remove}
          themeId={t.themeId}
          themes={t.available}
          onTheme={t.setTheme}
          onBackup={() => void backupAll()}
          onRestore={() => fileRef.current?.click()}
        />

        <main className="main">
          <header className="topbar">
            <select
              className="model"
              value={h.model}
              onChange={(e) => h.setModel(e.target.value)}
              disabled={h.streaming}
            >
              {h.models.length === 0 && <option value="">no models</option>}
              {h.models.map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </select>

            <div className="topbar-right">
              {h.stats?.tokPerSec && <span className="hint">{h.stats.tokPerSec.toFixed(1)} tok/s</span>}
              <button
                className={`ghost ${showSystem ? 'on' : ''}`}
                onClick={() => setShowSystem((v) => !v)}
                disabled={!h.activeConversation}
                title="System prompt for this conversation"
              >
                system
              </button>
            </div>
          </header>

          {showSystem && h.activeConversation && (
            <div className="system-panel">
              <textarea
                value={sysDraft}
                onChange={(e) => onSystemChange(e.target.value)}
                onBlur={flushSystem}
                placeholder="System prompt for this conversation. Saved as you type."
                rows={3}
              />
            </div>
          )}

          <Chat
            messages={h.messages}
            streaming={h.streaming}
            onRegenerate={h.regenerate}
            onEdit={h.editLast}
          />

          {h.error && <div className="error">{h.error}</div>}
          {notice && (
            <div className="notice" onClick={() => setNotice(null)}>
              {notice}
            </div>
          )}

          <Composer streaming={h.streaming} onSend={h.send} onStop={h.stop} />
        </main>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={onImportFile}
      />

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={actions}
        conversations={h.conversations}
        onSelect={(id) => void h.select(id)}
        search={searchMessages}
      />
    </div>
  )
}
