import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import Composer from './components/Composer'
import { useHearth } from './hooks/useHearth'

export default function App() {
  const h = useHearth()
  const [showSystem, setShowSystem] = useState(false)
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

  function flushSystem() {
    if (sysTimer.current !== null) {
      clearTimeout(sysTimer.current)
      sysTimer.current = null
    }
    h.setSystemPrompt(sysRef.current)
  }

  return (
    <div className="app">
      <Sidebar
        conversations={h.conversations}
        activeId={h.activeId}
        disabled={h.streaming}
        onSelect={h.select}
        onCreate={h.create}
        onDelete={h.remove}
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

        <Composer streaming={h.streaming} onSend={h.send} onStop={h.stop} />
      </main>
    </div>
  )
}
