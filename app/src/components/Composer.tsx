import { useRef, useState } from 'react'

type Props = {
  streaming: boolean
  onSend: (text: string) => void
  onStop: () => void
}

export default function Composer({ streaming, onSend, onStop }: Props) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  function submit() {
    const text = value.trim()
    if (!text || streaming) return
    setValue('')
    onSend(text)
    ref.current?.focus()
  }

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Message…"
        rows={2}
        autoFocus
      />
      <div className="composer-row">
        <span className="hint">Enter to send · Shift+Enter for a newline</span>
        {streaming ? (
          <button className="stop" onClick={onStop}>Stop</button>
        ) : (
          <button onClick={submit} disabled={!value.trim()}>Send</button>
        )}
      </div>
    </div>
  )
}
