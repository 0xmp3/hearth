import { useState } from 'react'
import Dialog from './Dialog'
import { BUDGET_STOPS, formatTokens, nearestStopIndex } from '../lib/budget'
import BackendPanel from './BackendPanel'
import { setBackendUrl, DEFAULT_BACKEND } from '../lib/config'
import { manager } from '../lib/backend'
import SearxngPanel from './SearxngPanel'
import SpeechPanel from './SpeechPanel'
import type { ModelInfo } from '../lib/models'

type Props = {
  onClose: () => void
  onExport: () => void
  onRestore: () => void
  baseUrl: string
  models: ModelInfo[]
  conversationCount: number
  messageCount: number
  themeId: string
  themes: { id: string; name: string }[]
  themeProblems: { file: string; reason: string }[]
  onExportTheme: () => void
  onTheme: (id: string) => void
  showReasoning: boolean
  onShowReasoning: (value: boolean) => void
  maxTokens: number
  onMaxTokens: (value: number) => void
  modelCtx?: number
  sidebarCollapsible: boolean
  onSidebarCollapsible: (value: boolean) => void
  showMetrics: boolean
  onShowMetrics: (value: boolean) => void
  onModels: () => void
  layout: 'sidebar' | 'tabs'
  onLayout: (value: 'sidebar' | 'tabs') => void
  onServerChanged: () => void
  /** Called when the speech panel changes something the app mirrors. */
  onSpeech?: () => void
  autoSpeak: boolean
  onAutoSpeak: (value: boolean) => void
  speechVoice: string
  onSpeechVoice: (id: string) => void
  network: { enabled: boolean; available: boolean | null; busy: boolean; error: string | null }
  onNetwork: (enabled: boolean) => void
  search: { provider: 'off' | 'brave' | 'searxng'; hasKey: boolean; searxngUrl: string }
  onSearch: (patch: { provider?: string; braveKey?: string; searxngUrl?: string }) => Promise<unknown>
  onTestSearch: (query: string) => Promise<{ title: string; url: string }[] | null>
  workspace: { enabled: boolean; path: string; exists: boolean; error?: string }
  workspaceBusy: boolean
  workspaceError: string | null
  onWorkspace: (patch: { path?: string; enabled?: boolean }) => Promise<unknown>
  onCheckWorkspace: () => Promise<{ entries: string[]; truncated: boolean } | null>
}

export default function SettingsDialog({
  onClose,
  onExport,
  onRestore,
  baseUrl,
  models,
  conversationCount,
  messageCount,
  themeId,
  themes,
  themeProblems,
  onExportTheme,
  onTheme,
  showReasoning,
  onShowReasoning,
  maxTokens,
  onMaxTokens,
  modelCtx,
  sidebarCollapsible,
  onSidebarCollapsible,
  showMetrics,
  onShowMetrics,
  onModels,
  layout,
  onLayout,
  onServerChanged,
  onSpeech,
  autoSpeak,
  onAutoSpeak,
  speechVoice,
  onSpeechVoice,
  network,
  onNetwork,
  search,
  onSearch,
  onTestSearch,
  workspace,
  workspaceBusy,
  workspaceError,
  onWorkspace,
  onCheckWorkspace,
}: Props) {
  const [backendUrl, setBackendUrlDraft] = useState(baseUrl)
  const [bindHost, setBindHost] = useState('')
  const [backendNote, setBackendNote] = useState<string | null>(null)
  const [wsPath, setWsPath] = useState(workspace.path)
  const [wsCheck, setWsCheck] = useState<string | null>(null)
  const [wsChecking, setWsChecking] = useState(false)
  // The key is write-only: the manager never sends it back, so the field starts
  // empty and only ever carries a new value.
  const [keyDraft, setKeyDraft] = useState('')
  const [testQuery, setTestQuery] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  async function test() {
    const q = testQuery.trim()
    if (!q) return
    setTesting(true)
    setTestResult(null)
    const hits = await onTestSearch(q)
    setTesting(false)
    setTestResult(hits ? `${hits.length} result${hits.length === 1 ? '' : 's'}${hits[0] ? ` — first: ${hits[0].title}` : ''}` : 'that did not work — the reason is above')
  }
  return (
    <Dialog
      title="Settings"
      onClose={onClose}
      footer={<button onClick={onClose}>Done</button>}
    >
      <section className="setting">
        <h3>Appearance</h3>
        <label className="field">
          <span>Theme</span>
          <select value={themeId} onChange={(e) => onTheme(e.target.value)}>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <em className="hint">
            Drop a <code>.json</code> theme into <code>data/themes/</code> and it appears
            here. Export the current one to get a valid starting point.
          </em>
        </label>

        <div className="row">
          <button className="ghost" onClick={onExportTheme}>
            Export this theme
          </button>
        </div>

        {themeProblems.length > 0 && (
          <div className="error">
            {themeProblems.map((p) => (
              <div key={p.file}>
                <code>{p.file}</code>: {p.reason}
              </div>
            ))}
          </div>
        )}

        <label className="field">
          <span>Reply budget — {formatTokens(maxTokens)}</span>
          <input
            type="range"
            min={0}
            max={BUDGET_STOPS.length - 1}
            step={1}
            value={nearestStopIndex(maxTokens)}
            onChange={(e) => onMaxTokens(BUDGET_STOPS[Number(e.target.value)])}
          />
          <em className="hint">
            the most a single reply may generate. The server stops at its own context
            limit{modelCtx ? ` (${formatTokens(modelCtx)} here)` : ''}, whatever you ask for.
          </em>
        </label>

        <label className="field">
          <span>Layout</span>
          <select value={layout} onChange={(e) => onLayout(e.target.value as 'sidebar' | 'tabs')}>
            <option value="sidebar">Sidebar</option>
            <option value="tabs">Tabs across the top</option>
          </select>
        </label>

        {layout === 'sidebar' && (
          <label className="check">
            <input
              type="checkbox"
              checked={sidebarCollapsible}
              onChange={(e) => onSidebarCollapsible(e.target.checked)}
            />
            <span>
              Collapsible sidebar
              <em>collapse the conversation list to a narrow rail</em>
            </span>
          </label>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={showReasoning}
            onChange={(e) => onShowReasoning(e.target.checked)}
          />
          <span>
            Show reasoning
            <em>the thinking block above replies, when the model produces one</em>
          </span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={showMetrics}
            onChange={(e) => onShowMetrics(e.target.checked)}
          />
          <span>
            System metrics
            <em>
              a strip in the sidebar: VRAM, tokens per second, and the machine behind them.
              Sampling only runs while it is on.
            </em>
          </span>
        </label>
      </section>

      <section className="setting">
        <h3>Data</h3>
        <p className="hint">
          {conversationCount} conversation{conversationCount === 1 ? '' : 's'} ·{' '}
          {messageCount} message{messageCount === 1 ? '' : 's'} stored on this machine.
        </p>
        <div className="row">
          <button onClick={onExport}>Export…</button>
          <button onClick={onRestore}>Restore…</button>
        </div>
      </section>

      <section className="setting">
        <h3>Backend</h3>
        <label className="field">
          <span>Endpoint</span>
          <input
            type="text"
            value={backendUrl}
            spellCheck={false}
            onChange={(e) => setBackendUrlDraft(e.target.value)}
            onBlur={() => {
              const next = backendUrl.trim()
              if (!next || next === baseUrl) return
              setBackendNote(
                setBackendUrl(next) ? null : 'that is not an http(s) address — nothing changed',
              )
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
          <em className="hint">
            where llama-server is. Change it when the model runs elsewhere — a test VM pointing at
            the host, for example — and the page reloads to use it. Default {DEFAULT_BACKEND}.
          </em>
          {backendNote && <em className="hint">{backendNote}</em>}
        </label>

        <label className="field">
          <span>Bind address</span>
          <div className="row">
            <input
              type="text"
              value={bindHost}
              placeholder="127.0.0.1"
              spellCheck={false}
              onChange={(e) => setBindHost(e.target.value)}
            />
            <button
              className="ghost"
              disabled={!bindHost.trim()}
              onClick={async () => {
                try {
                  await manager.saveConfig({ bindHost: bindHost.trim() } as never)
                  setBackendNote(`bind address saved: ${bindHost.trim()} — restart the server to apply`)
                } catch (err) {
                  setBackendNote((err as Error).message)
                }
              }}
            >
              Save
            </button>
          </div>
          <em className="hint">
            what llama-server listens on. Loopback by default; <code>0.0.0.0</code> exposes it to
            anything that can reach this machine, so scope a firewall rule to the one subnet that
            needs it.
          </em>
        </label>
        <p className="hint">
          {models.length === 0
            ? 'No models reported by the server.'
            : `${models.length} model${models.length === 1 ? '' : 's'}: ${models.map((m) => m.id).join(', ')}`}
        </p>
        {modelCtx ? (
          <p className="hint">
            Server context: {formatTokens(modelCtx)} — what this server was launched with
            (<code>--ctx-size</code>), not the model's maximum.
          </p>
        ) : null}

        <BackendPanel onServerChanged={onServerChanged} />
        <div className="row">
          <button className="ghost" onClick={onModels}>Browse model folder…</button>
        </div>
      </section>

      <section className="setting">
        <h3>Workspace</h3>
        <p className="hint">
          A folder the model may read — notes, docs, a codebase. It gets three read-only tools
          (list, search, read) and nothing else: no writing, no deleting, and nothing outside the
          folder, whatever path it asks for. Off until you point it at one.
        </p>
        <label className="field">
          <span>Folder</span>
          <div className="row">
            <input
              type="text"
              value={wsPath}
              placeholder="C:/Users/You/Documents/project"
              spellCheck={false}
              onChange={(e) => setWsPath(e.target.value)}
              onBlur={() => {
                if (wsPath.trim() !== workspace.path) void onWorkspace({ path: wsPath.trim() })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && wsPath.trim() !== workspace.path) {
                  void onWorkspace({ path: wsPath.trim() })
                }
              }}
            />
            <button
              className="ghost"
              disabled={wsChecking || !workspace.exists}
              onClick={async () => {
                setWsChecking(true)
                const out = await onCheckWorkspace()
                setWsChecking(false)
                setWsCheck(
                  out
                    ? `${out.entries.length} entries at the top${out.truncated ? ' (truncated)' : ''}: ${out.entries.slice(0, 6).join(', ')}`
                    : 'that folder could not be read',
                )
              }}
            >
              {wsChecking ? 'Reading…' : 'Check'}
            </button>
          </div>
          {workspace.error && <em className="hint">{workspace.error}</em>}
          {wsCheck && <em className="hint">{wsCheck}</em>}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={workspace.enabled}
            disabled={workspaceBusy || !workspace.exists}
            onChange={(e) => void onWorkspace({ enabled: e.target.checked })}
          />
          <span>
            Let the model read this folder
            <em>
              {!workspace.path
                ? 'set a folder first'
                : !workspace.exists
                  ? 'that folder is not readable right now'
                  : workspace.enabled
                    ? 'on — list_files, search_files and read_file are offered'
                    : 'off — the folder is remembered but not used'}
            </em>
          </span>
        </label>
        {workspaceError && <div className="error">{workspaceError}</div>}
      </section>

      <section className="setting">
        <h3>Network</h3>
        <p className="hint">
          Off by default. While it is on, the model can read a page you give it, and that
          request — and nothing else — leaves this machine from the manager, never from the
          browser. Pages on this machine are refused, and every read is listed in the
          reply it belongs to.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={network.enabled}
            disabled={network.busy || network.available === false}
            onChange={(e) => onNetwork(e.target.checked)}
          />
          <span>
            Allow network access
            <em>
              {network.available === false
                ? 'the manager is not running — start it with "npm run manager"'
                : network.enabled
                  ? 'on — the model may fetch pages you name'
                  : 'off — nothing can leave this machine'}
            </em>
          </span>
        </label>
        <label className="field">
          <span>Search provider</span>
          <select
            value={search.provider}
            disabled={network.busy || network.available === false}
            onChange={(e) => void onSearch({ provider: e.target.value })}
          >
            <option value="off">Off — read URLs, no search</option>
            <option value="brave">Brave Search API</option>
            <option value="searxng">SearXNG instance</option>
          </select>
          <em className="hint">
            search needs a provider; reading a URL does not. Nothing here is used until
            network access is on.
          </em>
        </label>

        {search.provider === 'brave' && (
          <label className="field">
            <span>Brave API key {search.hasKey ? '— saved' : ''}</span>
            <div className="row">
              <input
                type="password"
                value={keyDraft}
                placeholder={search.hasKey ? '••••••••  (replace)' : 'paste the key from api.search.brave.com'}
                onChange={(e) => setKeyDraft(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                className="ghost"
                disabled={!keyDraft.trim()}
                onClick={() => {
                  void onSearch({ braveKey: keyDraft.trim() }).then(() => setKeyDraft(''))
                }}
              >
                Save key
              </button>
            </div>
            <em className="hint">
              stored by the manager in <code>data/config.json</code> — never in the browser,
              never in a backup, and never sent back to this page.
            </em>
          </label>
        )}

        {search.provider === 'searxng' && (
          <>
            <label className="field">
              <span>Install one</span>
              <SearxngPanel onUrl={(url) => void onSearch({ searxngUrl: url })} />
            </label>
            <label className="field">
              <span>SearXNG address</span>
            <div className="row">
              <input
                type="text"
                defaultValue={search.searxngUrl}
                placeholder="http://127.0.0.1:8888"
                spellCheck={false}
                onBlur={(e) => {
                  if (e.target.value.trim() !== search.searxngUrl) void onSearch({ searxngUrl: e.target.value.trim() })
                }}
              />
            </div>
            <em className="hint">
              yours, or the one installed above — with <code>json</code> enabled under
              <code>search.formats</code> in its settings.yml. The installer writes that for you.
            </em>
          </label>
          </>
        )}

        {search.provider !== 'off' && (
          <label className="field">
            <span>Try it</span>
            <div className="row">
              <input
                type="text"
                value={testQuery}
                placeholder="a query"
                onChange={(e) => setTestQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void test()
                }}
              />
              <button className="ghost" disabled={testing || !testQuery.trim()} onClick={() => void test()}>
                {testing ? 'Searching…' : 'Search'}
              </button>
            </div>
            {testResult && <em className="hint">{testResult}</em>}
          </label>
        )}

        {network.error && <div className="error">{network.error}</div>}
      </section>

      <section className="setting">
        <h3>Speech</h3>
        <p className="hint">
          Replies can be read aloud by a local voice model, cloned from a short recording you
          keep. It runs on the same llama.cpp engine as chat, in a second process that starts
          when you first speak and stops after ten idle minutes — nothing leaves this machine.
        </p>
        <SpeechPanel
          onState={() => onSpeech?.()}
          autoSpeak={autoSpeak}
          onAutoSpeak={onAutoSpeak}
          defaultVoice={speechVoice}
          onDefaultVoice={onSpeechVoice}
        />
      </section>

      <section className="setting">
        <h3>About</h3>
        <p className="hint">
          Hearth — a local chat client. No account, no telemetry. Nothing leaves this machine
          unless you switch network access on above.
        </p>
      </section>
    </Dialog>
  )
}
