import { useRef, useState } from 'react'

import ContextBar from './ContextBar'

type Props = {
  streaming: boolean
  used: number
  total: number
  onSend: (text: string) => void
  onStop: () => void
}

export default function Composer({ streaming, used, total, onSend, onStop }: Props) {
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
        placeholder="Message…  (Enter to send, Shift+Enter for a newline)"
        rows={2}
        autoFocus
      />
      <div className="composer-row">
        <ContextBar used={used} total={total} />
        {streaming ? (
          <button className="stop" onClick={onStop}>Stop</button>
        ) : (
          <button onClick={submit} disabled={!value.trim()}>Send</button>
        )}
      </div>
    </div>
  )
}
