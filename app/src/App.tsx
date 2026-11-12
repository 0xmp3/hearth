import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import Chat from './components/Chat'
import Composer from './components/Composer'
import Palette, { type PaletteAction } from './components/Palette'
import SettingsDialog from './components/SettingsDialog'
import ProfileDialog from './components/ProfileDialog'
import ExportDialog from './components/ExportDialog'
import RestoreDialog from './components/RestoreDialog'
import StatsDialog from './components/StatsDialog'
import MemoryDialog from './components/MemoryDialog'
import PromptsDialog from './components/PromptsDialog'
import ModelsDialog from './components/ModelsDialog'
import { useHearth } from './hooks/useHearth'
import { useCharacters } from './hooks/useCharacters'
import { useProfiles } from './hooks/useProfiles'
import { usePrefs } from './hooks/usePrefs'
import { useNetwork } from './hooks/useNetwork'
import { usePrompts } from './hooks/usePrompts'
import Dialog from './components/Dialog'
import { useTheme } from './theme/apply'
import { agentTurn } from './lib/turn'
import { countMessages, exportAll, importAll, listMessages, searchMessages, type Backup } from './lib/db'
import { backupFilename, download, slug, toJson, toMarkdown } from './lib/export'
import { BASE_URL } from './lib/config'

/**
 * A <select> can only carry strings, and "inherit the app-wide choice" has no
 * id of its own. Profile ids are UUIDs, so this sentinel cannot collide.
 */
const INHERIT = '__inherit'

/** The select's string value back to the field's three states. */
function fromScope(value: string): string | null | undefined {
  if (value === INHERIT) return undefined
  return value === '' ? null : value
}

type DialogName =
  | 'settings'
  | 'profile'
  | 'export'
  | 'restore'
  | 'stats'
  | 'prompts'
  | 'models'
  | 'memory'

export default function App() {
  const characters = useCharacters()
  const prompts = usePrompts()
  const { prefs, update: updatePrefs } = usePrefs()
  // Seeded once from the old preferences, so an existing name is not lost.
  const profiles = useProfiles({ name: prefs.userName, avatar: prefs.userAvatar })
  const user = {
    name: profiles.active?.name || 'User',
    avatar: profiles.active?.avatar || undefined,
  }
  // Egress is the manager's decision; this is the app's copy of the answer.
  const net = useNetwork()
  // agentTurn, not chatTurn: it runs tools and falls back to a single call when
  // there are none. Passing chatTurn here silently disabled the tool loop.
  const h = useHearth(agentTurn, (characterId) => characters.resolve(characterId), {
    maxTokens: prefs.maxTokens,
    resolveProfile: (profileId) => profiles.resolve(profileId),
    network: net.enabled,
    search: net.searchReady,
  })
  const t = useTheme()

  const [showSystem, setShowSystem] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogName | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
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

  // Context usage comes from the last reply's own token counts, so it is
  // measured rather than estimated.
  // undefined inherits the globally active profile; null means none.
  const characterValue = h.activeConversation
    ? h.activeConversation.characterId === null
      ? ''
      : (h.activeConversation.characterId ?? INHERIT)
    : INHERIT

  const profileValue = h.activeConversation
    ? h.activeConversation.profileId === null
      ? ''
      : (h.activeConversation.profileId ?? INHERIT)
    : INHERIT

  const ctxTotal = h.models.find((m) => m.id === h.model)?.ctx ?? 8192
  const lastStats = [...h.messages].reverse().find((m) => m.stats?.promptTokens)?.stats
  const ctxUsed = lastStats ? (lastStats.promptTokens ?? 0) + (lastStats.completionTokens ?? 0) : 0

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
    download(`${slug(conv.title)}.json`, toJson(conv, messages, characters.characters), 'application/json')
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
    { id: 'prompts', label: 'Prompt library', run: () => setDialog('prompts') },
    { id: 'models', label: 'Models', hint: 'browse a folder', run: () => setDialog('models') },
    { id: 'stats', label: 'Stats', hint: 'speed history', run: () => setDialog('stats') },
    { id: 'memory', label: 'Memory', hint: 'what it remembers', run: () => setDialog('memory') },
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

      {prefs.layout === 'tabs' && (
        <TabBar
          conversations={h.conversations}
          activeId={h.activeId}
          disabled={h.streaming}
          user={user}
          onSelect={h.select}
          onCreate={h.create}
          onDelete={(id) => setConfirmDelete(id)}
          onProfile={() => setDialog('profile')}
          onSettings={() => setDialog('settings')}
        />
      )}

      <div
        className={`app-body${prefs.layout === 'tabs' ? ' tabs' : ''}${
          prefs.layout === 'sidebar' && prefs.sidebarCollapsible && prefs.sidebarCollapsed ? ' collapsed' : ''
        }`}
      >
        {prefs.layout === 'sidebar' && (
        <Sidebar
          conversations={h.conversations}
          activeId={h.activeId}
          disabled={h.streaming}
          collapsed={prefs.sidebarCollapsible && prefs.sidebarCollapsed}
          collapsible={prefs.sidebarCollapsible}
          user={user}
          model={h.model}
          showMetrics={prefs.showMetrics}
          onToggleCollapse={() => updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed })}
          onSelect={h.select}
          onCreate={h.create}
          onDelete={(id) => setConfirmDelete(id)}
          onSettings={() => setDialog('settings')}
          onProfile={() => setDialog('profile')}
          onPin={h.togglePin}
        />
        )}

        <main className="main">
          <header className="topbar">
            <span className="chat-title" title={h.activeConversation?.title}>
              {h.activeConversation?.title ?? 'Hearth'}
            </span>

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

            {/* Who you are, then who it is — the same three-way choice for
                each: inherit the app-wide pick, pin one, or opt out. */}
            {profiles.profiles.length > 0 && (
              <select
                className="model profile"
                value={profileValue}
                onChange={(e) => void h.setConversationProfile(fromScope(e.target.value))}
                disabled={h.streaming || !h.activeConversation}
                title="Who you are, for this conversation"
              >
                <option value={INHERIT}>
                  {profiles.active ? `↳ ${profiles.active.name}` : '↳ inherit'}
                </option>
                {profiles.profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                <option value="">no profile</option>
              </select>
            )}

            {characters.characters.length > 0 && (
              <select
                className="model character"
                value={characterValue}
                onChange={(e) => void h.setConversationCharacter(fromScope(e.target.value))}
                disabled={h.streaming || !h.activeConversation}
                title="Character for this conversation"
              >
                <option value={INHERIT}>
                  {characters.active ? `↳ ${characters.active.name}` : '↳ inherit'}
                </option>
                {characters.characters.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                <option value="">no character</option>
              </select>
            )}

            <div className="topbar-right">
              {net.enabled && (
                <button
                  className="ghost net"
                  onClick={() => setDialog('settings')}
                  title="Network access is on: pages the model reads leave this machine"
                >
                  net
                </button>
              )}
              {h.stats?.tokPerSec && (
                <button className="link tok" onClick={() => setDialog('stats')} title="Speed history">
                  {h.stats.tokPerSec.toFixed(1)} tok/s
                </button>
              )}
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
              <div className="row between">
                <button className="link" onClick={() => setDialog('prompts')}>
                  prompt library
                </button>
                <span className="hint">saved as you type</span>
              </div>
            </div>
          )}

          <Chat
            messages={h.messages}
            streaming={h.streaming}
            showReasoning={prefs.showReasoning}
            resolveIdentity={(characterId) => {
              const p = characters.resolve(characterId)
              return {
                name: p?.name ?? (prefs.assistantName || 'Hearth'),
                avatar: p?.avatar ?? (prefs.assistantAvatar || undefined),
              }
            }}
            user={user}
            onRegenerate={h.regenerate}
            onEdit={h.editLast}
          />

          {h.error && <div className="error">{h.error}</div>}
          {notice && (
            <div className="notice" onClick={() => setNotice(null)}>
              {notice}
            </div>
          )}

          <Composer
            model={h.model}
            streaming={h.streaming}
            used={ctxUsed}
            total={ctxTotal}
            onSend={h.send}
            onStop={h.stop}
          />
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
          themeProblems={t.problems}
          onExportTheme={() =>
            download(`${t.theme.id}.json`, JSON.stringify(t.theme, null, 2), 'application/json')
          }
          onTheme={t.setTheme}
          showReasoning={prefs.showReasoning}
          onShowReasoning={(value) => updatePrefs({ showReasoning: value })}
          maxTokens={prefs.maxTokens}
          onMaxTokens={(value) => updatePrefs({ maxTokens: value })}
          modelCtx={ctxTotal}
          sidebarCollapsible={prefs.sidebarCollapsible}
          onSidebarCollapsible={(v) => updatePrefs({ sidebarCollapsible: v })}
          showMetrics={prefs.showMetrics}
          onShowMetrics={(v) => updatePrefs({ showMetrics: v })}
          onModels={() => setDialog('models')}
          layout={prefs.layout}
          onLayout={(value) => updatePrefs({ layout: value })}
          network={{ enabled: net.enabled, available: net.available, busy: net.busy, error: net.error }}
          onNetwork={(value) => void net.toggle(value)}
          search={net.search}
          onSearch={net.saveSearch}
          onTestSearch={net.testSearch}
          onServerChanged={() => void h.reloadModels()}
        />
      )}

      {dialog === 'profile' && (
        <ProfileDialog
          onClose={() => setDialog(null)}
          profiles={profiles.profiles}
          activeProfileId={profiles.activeId}
          onSelectProfile={profiles.select}
          onSaveProfile={profiles.save}
          onRemoveProfile={profiles.remove}
          characters={characters.characters}
          activeCharacterId={characters.activeId}
          onSelectCharacter={characters.select}
          onSaveCharacter={characters.save}
          onRemoveCharacter={characters.remove}
          assistant={{
            name: prefs.assistantName || 'Hearth',
            avatar: prefs.assistantAvatar || undefined,
          }}
          onAssistantName={(name) => updatePrefs({ assistantName: name })}
          onAssistantAvatar={(url) => updatePrefs({ assistantAvatar: url })}
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

      {dialog === 'stats' && <StatsDialog onClose={() => setDialog(null)} />}

      {dialog === 'memory' && (
        <MemoryDialog
          memories={h.memories}
          capturing={h.capturing}
          condensing={h.condensing}
          onClose={() => setDialog(null)}
          onCapture={h.captureNow}
          onCondense={h.condenseNow}
          onChanged={h.refreshMemories}
        />
      )}

      {dialog === 'models' && <ModelsDialog onClose={() => setDialog(null)} />}

      {dialog === 'prompts' && (
        <PromptsDialog
          onClose={() => setDialog(null)}
          prompts={prompts.prompts}
          onSave={prompts.save}
          onRemove={prompts.remove}
          canUse={Boolean(h.activeConversation)}
          onUse={(text) => {
            setSysDraft(text)
            sysRef.current = text
            void h.setSystemPrompt(text)
          }}
        />
      )}

      {confirmDelete && (
        <Dialog
          title="Delete conversation"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                onClick={() => {
                  void h.remove(confirmDelete)
                  setConfirmDelete(null)
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p className="hint">
            “{h.conversations.find((c) => c.id === confirmDelete)?.title ?? 'This conversation'}”
            and its messages will be removed. This cannot be undone — export first if you
            want to keep it.
          </p>
        </Dialog>
      )}
    </div>
  )
}
