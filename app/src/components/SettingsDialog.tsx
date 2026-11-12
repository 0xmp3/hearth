import Dialog from './Dialog'
import { BUDGET_STOPS, formatTokens, nearestStopIndex } from '../lib/budget'
import BackendPanel from './BackendPanel'
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
  userName: string
  onUserName: (value: string) => void
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
  userName,
  onUserName,
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
}: Props) {
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
          <span>Your name</span>
          <input
            value={userName}
            onChange={(e) => onUserName(e.target.value)}
            placeholder="You"
          />
        </label>

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
          <input value={baseUrl} readOnly />
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
        <h3>About</h3>
        <p className="hint">
          Hearth v1.1 — a local chat client. Nothing leaves this machine; there is no
          account and no telemetry.
        </p>
      </section>
    </Dialog>
  )
}
