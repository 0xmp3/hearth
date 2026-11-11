import { useRef, useState } from 'react'
import { streamChat, type ChatMessage, type Stats } from './lib/stream'
import { BASE_URL, MODEL, SYSTEM_PROMPT } from './lib/config'

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function send() {
    const text = input.trim()
    if (!text || streaming) return

    const history: ChatMessage[] = [
      ...(SYSTEM_PROMPT ? [{ role: 'system' as const, content: SYSTEM_PROMPT }] : []),
      ...messages,
      { role: 'user', content: text },
    ]

    setMessages([...history, { role: 'assistant', content: '' }])
    setInput('')
    setError(null)
    setStats(null)
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChat({
        baseUrl: BASE_URL,
        messages: history,
        signal: controller.signal,
        onDelta: (delta) =>
          setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            next[next.length - 1] = { ...last, content: last.content + delta }
            return next
          }),
        onStats: setStats,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Not a failure: keep the partial reply.
      } else {
        setError((err as Error).message)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  return (
    <div className="app">
      <header>
        <span className="brand">hearth</span>
        <span className="model">{MODEL}</span>
      </header>

      <main>
        {messages.length === 0 && (
          <p className="empty">Nothing here yet. Say something.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            <div className="body">{m.content || (streaming ? '…' : '')}</div>
          </div>
        ))}
        {error && <div className="error">{error}</div>}
      </main>

      <footer>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Message…  (Enter to send, Shift+Enter for a newline)"
          rows={3}
          autoFocus
        />
        <div className="controls">
          <span className="stats">
            {stats?.tokPerSec ? `${stats.tokPerSec.toFixed(1)} tok/s` : ''}
          </span>
          {streaming ? (
            <button onClick={stop} className="stop">Stop</button>
          ) : (
            <button onClick={send} disabled={!input.trim()}>Send</button>
          )}
        </div>
      </footer>
    </div>
  )
}
