import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import { BUDGET_STOPS, formatTokens, nearestStopIndex } from '../lib/budget'
import BackendPanel from './BackendPanel'
import { setBackendUrl, DEFAULT_BACKEND } from '../lib/config'
import { manager } from '../lib/backend'
import SearxngPanel from './SearxngPanel'
import SpeechPanel from './SpeechPanel'
import RetrievalPanel from './RetrievalPanel'
import type { ModelInfo } from '../lib/models'
import { ALL_TOOLS_ON, NO_TOOLS, TOOL_INFO, familyOf, type ToolName } from '../lib/tools'
import type { EffortMode, TextStyle } from '../lib/db'

type Props = {
  onClose: () => void
  onExport: () => void
  onRestore: () => void
  onClear: () => void
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
  onShowReasoning: (v: boolean) => void
  motion: 'system' | 'on' | 'off'
  onMotion: (v: 'system' | 'on' | 'off') => void
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
  /** Called when the retrieval panel changes either engine, so the app re-reads readiness. */
  onRetrieval?: () => void
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
  /** Which tools the app may offer at all. A conversation can only narrow this. */
  tools: Record<ToolName, boolean>
  onTools: (patch: Partial<Record<ToolName, boolean>>) => void
  /** Defaults for new conversations; each conversation can override them. */
  effort: EffortMode
  onEffort: (effort: EffortMode) => void
  style: TextStyle
  onStyle: (style: TextStyle) => void
}

export default function SettingsDialog({
  onClose,
  onExport,
  onRestore,
  onClear,
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
  motion,
  onMotion,
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
  onRetrieval,
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
  tools,
  onTools,
  effort,
  onEffort,
  style,
  onStyle,
}: Props) {
  const [backendUrl, setBackendUrlDraft] = useState(baseUrl)
  const [bindHost, setBindHost] = useState('')
  const [allowRemoteBackend, setAllowRemoteBackend] = useState(false)
  const [backendNote, setBackendNote] = useState<string | null>(null)

  // The switch has to reflect what the manager actually has, not a default: a
  // checkbox that reads "off" while the manager allows it is a lie in the one
  // place someone would look to check.
  useEffect(() => {
    let alive = true
    manager
      .engine()
      .then((state) => {
        if (!alive) return
        const cfg = state.config as { allowRemoteBackend?: boolean }
        setAllowRemoteBackend(cfg.allowRemoteBackend === true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
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

        <label className="field">
          <span>Motion</span>
          <select value={motion} onChange={(e) => onMotion(e.target.value as 'system' | 'on' | 'off')}>
            <option value="system">follow the system</option>
            <option value="on">always animate</option>
            <option value="off">never animate</option>
          </select>
        </label>
        <p className="hint">
          Animated text only moves when this allows it. Windows' "Animation effects" switch is
          off on a lot of machines, and the browser reports that as a request for less motion —
          which Hearth follows by default. Override it here if you want the effects anyway.
        </p>

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
          <button className="ghost danger" onClick={onClear} disabled={conversationCount === 0}>
            Clear all chats…
          </button>
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

        <label className="field">
          <span>Backend on another machine</span>
          <div className="row">
            <input
              type="checkbox"
              checked={allowRemoteBackend}
              onChange={async (e) => {
                const next = e.target.checked
                setAllowRemoteBackend(next)
                try {
                  await manager.saveConfig({ allowRemoteBackend: next } as never)
                  setBackendNote(
                    next
                      ? 'saved — the manager will now proxy to a backend that is not on this machine'
                      : 'saved — the manager only proxies to a loopback backend again',
                  )
                } catch (err) {
                  setAllowRemoteBackend(!next)
                  setBackendNote((err as Error).message)
                }
              }}
            />{' '}
            allow an endpoint that is not loopback
          </div>
          <em className="hint">
            the manager proxies the app's chat and model requests, so it only forwards to a
            loopback address by default. Turn this on to point the endpoint above at another
            machine — the manager will then accept any address there, which is why it is off.
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
        <h3>Permissions</h3>
        <p className="hint">
          What this app may do at all. A conversation can narrow this list, never widen it, and the
          workspace and network switches above are a second gate underneath. A tool that is off is
          never offered to the model, so it cannot promise to use it.
        </p>

        <div className="row">
          <button className="ghost tiny" onClick={() => onTools(ALL_TOOLS_ON)}>
            Everything
          </button>
          <button
            className="ghost tiny"
            onClick={() => onTools({ ...NO_TOOLS, remember: true, search_history: true })}
          >
            Local only
          </button>
          <button className="ghost tiny" onClick={() => onTools(NO_TOOLS)}>
            No tools
          </button>
        </div>

        {(['local', 'web', 'files'] as const).map((family) => (
          <div key={family}>
            <h4>{family === 'local' ? 'Local' : family === 'web' ? 'Web' : 'Folder'}</h4>
            {TOOL_INFO.filter((t) => familyOf(t.name) === family).map((t) => (
              <label className="check" key={t.name}>
                <input
                  type="checkbox"
                  checked={tools[t.name]}
                  onChange={(e) => onTools({ [t.name]: e.target.checked })}
                />
                <span>
                  <code>{t.name}</code>
                  <em>{t.detail}</em>
                </span>
              </label>
            ))}
          </div>
        ))}

        <label className="field">
          <span>Reasoning effort</span>
          <select value={effort} onChange={(e) => onEffort(e.target.value as EffortMode)}>
            <option value="default">backend default</option>
            <option value="none">none — answer immediately</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
          <em className="hint">The default for new conversations. A conversation can override it.</em>
        </label>

        <label className="field">
          <span>Emphasis</span>
          <select value={style} onChange={(e) => onStyle(e.target.value as TextStyle)}>
            <option value="off">plain — bold is bold</option>
            <option value="colour">colour — the character's hue</option>
            <option value="expressive">expressive — colour, and a slow drift</option>
          </select>
          <em className="hint">The default for new conversations. A conversation can override it.</em>
        </label>
      </section>

      <section className="setting">
        <h3>Retrieval</h3>
        <p className="hint">
          Search your own conversations. Two small local models: one turns a message into numbers,
          the other reorders the results. Both start when needed and stop after ten idle minutes.
        </p>
        <RetrievalPanel onState={() => onRetrieval?.()} />
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
