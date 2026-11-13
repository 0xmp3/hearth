import Dialog from './Dialog'
import { useReducedMotion } from '../hooks/useReducedMotion'
import type { EffortMode, TextStyle, ToolMode } from '../lib/db'

// What this conversation is allowed to use.
//
// A conversation can narrow the tools the app allows, never widen them: the
// manager's network and workspace switches stay the outer gate, and this only
// decides which of the permitted families this chat gets. That is what makes the
// three modes real rather than cosmetic — roleplay is "files off, web off", not
// a different app.

type Props = {
  mode: ToolMode
  onMode: (mode: ToolMode) => void
  effort: EffortMode
  onEffort: (effort: EffortMode) => void
  style: TextStyle
  onStyle: (style: TextStyle) => void
  /** The app's motion preference, so the note below can be honest. */
  motion: 'system' | 'on' | 'off'
  available: { web: boolean; search: boolean; files: boolean }
  onClose: () => void
}

const MODES: { id: ToolMode; name: string; detail: string }[] = [
  {
    id: 'default',
    name: 'Everything available',
    detail: 'memory, web tools and the folder — whatever Settings allows.',
  },
  {
    id: 'files',
    name: 'Folder only',
    detail: 'read the workspace, nothing leaves the machine, no memory writes.',
  },
  {
    id: 'web',
    name: 'Web only',
    detail: 'read and search the web, no folder access, no memory writes.',
  },
  {
    id: 'none',
    name: 'No tools',
    detail: 'plain chat: no tools declared, so the model cannot claim any.',
  },
]

export default function ToolsDialog({
  mode,
  onMode,
  effort,
  onEffort,
  style,
  onStyle,
  motion,
  available,
  onClose,
}: Props) {
  // Motion is silenced by the system on a lot of machines, and "expressive"
  // then colours without moving — which looks like a broken feature unless it
  // is named.
  const reduced = useReducedMotion()
  const silenced = style === 'expressive' && (motion === 'off' || (motion === 'system' && reduced))
  return (
    <Dialog
      title="This conversation"
      onClose={onClose}
      footer={<button onClick={onClose}>Done</button>}
    >
      <p className="hint">
        Settings decides what this app may ever do; this decides what <em>this chat</em> may use.
        Narrowing needs no restart, and the request only declares what is left.
      </p>

      <ul className="mode-list">
        {MODES.map((m) => {
          const unavailable =
            (m.id === 'web' && !available.web) ||
            (m.id === 'files' && !available.files)
          return (
            <li key={m.id} className={mode === m.id ? 'active' : ''}>
              <button
                className="mode-pick"
                onClick={() => onMode(m.id)}
                aria-pressed={mode === m.id}
              >
                <span className="mode-name">{m.name}</span>
                <span className="character-note">{m.detail}</span>
                {unavailable && (
                  <span className="mode-warn">
                    {m.id === 'web'
                      ? 'network access is off in Settings'
                      : 'no workspace folder is open in Settings'}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <h4>Thinking</h4>
      <p className="hint">
        How much the model may think before it answers. A backend that does not support this
        ignores it; one that rejects the value will say so in the reply.
      </p>
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
      </label>

      <h4>Text</h4>
      <p className="hint">
        How bold and italic phrases are dressed. The model already decides which words
        matter — it emphasises them — so this only changes what that emphasis looks like.
        Phrases over 60 characters are left alone: a whole sentence is an explanation, not
        a flourish. Nothing is sent to the model, and turning this off is instant.
      </p>
      <label className="field">
        <span>Emphasis</span>
        <select value={style} onChange={(e) => onStyle(e.target.value as TextStyle)}>
          <option value="off">plain — bold is bold</option>
          <option value="colour">colour — the character's hue</option>
          <option value="expressive">expressive — colour, and a slow drift</option>
        </select>
      </label>
      {silenced && (
        <p className="hint warn-note">
          {motion === 'off'
            ? 'Motion is switched off in Settings, so this will colour without moving.'
            : 'Your system asks for less motion, so this will colour without moving. Settings → Appearance → Motion overrides that.'}
        </p>
      )}

      <p className="hint">
        Available now: {available.files ? 'folder' : 'no folder'} ·{' '}
        {available.web ? (available.search ? 'web + search' : 'web read only') : 'no web'} · memory
        local
      </p>
    </Dialog>
  )
}
