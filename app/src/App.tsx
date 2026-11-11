import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import Composer from './components/Composer'
import { useHearth } from './hooks/useHearth'

export default function App() {
  const h = useHearth()

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
          {h.stats?.tokPerSec && <span className="hint">{h.stats.tokPerSec.toFixed(1)} tok/s</span>}
        </header>

        <Chat messages={h.messages} streaming={h.streaming} />

        {h.error && <div className="error">{h.error}</div>}

        <Composer streaming={h.streaming} onSend={h.send} onStop={h.stop} />
      </main>
    </div>
  )
}
