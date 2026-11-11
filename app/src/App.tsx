import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import Composer from './components/Composer'
import Palette, { type PaletteAction } from './components/Palette'
import SettingsDialog from './components/SettingsDialog'
import ProfileDialog from './components/ProfileDialog'
import ExportDialog from './components/ExportDialog'
import RestoreDialog from './components/RestoreDialog'
import { useHearth } from './hooks/useHearth'
import { usePersonas } from './hooks/usePersonas'
import { useTheme } from './theme/apply'
import { chatTurn } from './lib/turn'
import { countMessages, exportAll, importAll, listMessages, searchMessages, type Backup } from './lib/db'
import { backupFilename, download, slug, toJson, toMarkdown } from './lib/export'
import { BASE_URL } from './lib/config'

type DialogName = 'settings' | 'profile' | 'export' | 'restore'

export default function App() {
  const personas = usePersonas()
  const h = useHearth(chatTurn, personas.active?.systemPrompt)
  const t = useTheme()

  const [showSystem, setShowSystem] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogName | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [messageCount, setMessageCount] = useState(0)
  const [sysDraft, setSysDraft] = useState('')
  const sysRef = useRef('')
  const sysTimer = useRef<number | null>(null)

  // Keep the draft in step with whichever conversation is open.
  useEffect(() => {
    const value = h.activeConversation?.systemPrompt ?? ''
    setSysDraft(value)
    sysRef.current = value
  }, [h.activeConversation?.id])

  // Window title follows the conversation.
  useEffect(() => {
    document.title = h.activeConversation?.title
      ? `${h.activeConversation.title} — Hearth`
      : 'Hearth'
  }, [h.activeConversation?.title])

  useEffect(() => {
    if (dialog === 'settings') void countMessages().then(setMessageCount)
  }, [dialog, h.messages.length])

  // One place decides what Escape means: palette, then dialog, then stop.
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
        if (dialog) {
          setDialog(null)
          return
        }
        if (h.streaming) h.stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, dialog, h.streaming, h.stop])

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

  function flushSystem() {
    if (sysTimer.current !== null) {
      clearTimeout(sysTimer.current)
      sysTimer.current = null
    }
    h.setSystemPrompt(sysRef.current)
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  async function exportScope(scope: 'all' | string) {
    if (scope === 'all') {
      const backup = await exportAll()
      download(backupFilename(), JSON.stringify(backup, null, 2), 'application/json')
      setNotice(`Exported ${plural(backup.conversations.length, 'conversation')}, ${plural(backup.messages.length, 'message')}.`)
      return
    }
    const conv = h.conversations.find((c) => c.id === scope)
    if (!conv) return
    const messages = await listMessages(conv.id)
    download(`${slug(conv.title)}.json`, toJson(conv, messages, personas.personas), 'application/json')
    setNotice(`Exported “${conv.title}”.`)
  }

  async function restore(backup: Backup, ids: string[]) {
    const result = await importAll(backup, ids)
    await h.reload()
    setNotice(`Restored ${plural(result.conversations, 'conversation')}, ${plural(result.messages, 'message')}.`)
  }

  function exportMarkdown() {
    const conv = h.activeConversation
    if (!conv) return
    download(`${slug(conv.title)}.md`, toMarkdown(conv, h.messages), 'text/markdown')
  }

  const actions: PaletteAction[] = [
    { id: 'new', label: 'New conversation', run: () => void h.create() },
    ...(h.activeConversation
      ? [{ id: 'export-md', label: 'Export this conversation as Markdown', run: exportMarkdown }]
      : []),
    { id: 'export', label: 'Export…', hint: 'all or one', run: () => setDialog('export') },
    { id: 'restore', label: 'Restore…', hint: 'from a backup file', run: () => setDialog('restore') },
    { id: 'settings', label: 'Settings', run: () => setDialog('settings') },
    { id: 'profile', label: 'Profiles', run: () => setDialog('profile') },
    { id: 'system', label: 'Toggle system prompt', run: () => setShowSystem((v) => !v) },
    ...(h.streaming ? [{ id: 'stop', label: 'Stop generating', run: h.stop }] : []),
  ]

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
          onSettings={() => setDialog('settings')}
          onProfile={() => setDialog('profile')}
          profileName={personas.active?.name ?? null}
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

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={actions}
        conversations={h.conversations}
        onSelect={(id) => void h.select(id)}
        search={searchMessages}
      />

      {dialog === 'settings' && (
        <SettingsDialog
          onClose={() => setDialog(null)}
          onExport={() => setDialog('export')}
          onRestore={() => setDialog('restore')}
          baseUrl={BASE_URL}
          models={h.models}
          conversationCount={h.conversations.length}
          messageCount={messageCount}
          themeId={t.themeId}
          themes={t.available}
          onTheme={t.setTheme}
        />
      )}

      {dialog === 'profile' && (
        <ProfileDialog
          onClose={() => setDialog(null)}
          personas={personas.personas}
          activeId={personas.activeId}
          onSelect={personas.select}
          onSave={personas.save}
          onRemove={personas.remove}
        />
      )}

      {dialog === 'export' && (
        <ExportDialog
          onClose={() => setDialog(null)}
          conversations={h.conversations}
          activeId={h.activeId}
          onExport={(scope) => void exportScope(scope)}
        />
      )}

      {dialog === 'restore' && (
        <RestoreDialog onClose={() => setDialog(null)} onRestore={restore} />
      )}
    </div>
  )
}
