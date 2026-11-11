import { useRef, useState } from 'react'

import ContextBar from './ContextBar'
import { formatSize, isSupported, readAttachment, type Attachment } from '../lib/attachments'
import { supportsVision } from '../lib/capabilities'

type Props = {
  model: string
  streaming: boolean
  used: number
  total: number
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
}

export default function Composer({ model, streaming, used, total, onSend, onStop }: Props) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [noVision, setNoVision] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function addFiles(files: File[]) {
    if (!files.length) return
    setError(null)
    setBusy(true)
    try {
      const next: Attachment[] = []
      for (const file of files) {
        if (!isSupported(file)) {
          setError(`${file.name}: unsupported type`)
          continue
        }
        next.push(await readAttachment(file))
      }
      if (next.length) {
        setAttachments((prev) => [...prev, ...next])
        // An image sent to a model without a projector comes back as an empty
        // reply, so say so now rather than after the fact.
        if (next.some((a) => a.kind === 'image')) {
          setNoVision(!(await supportsVision(model)))
        }
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function submit() {
    const text = value.trim()
    if ((!text && !attachments.length) || streaming || busy) return
    if (noVision && attachments.some((a) => a.kind === 'image')) {
      setError('This model has no vision projector, so it cannot see images. Load a vision model, or remove the image.')
      return
    }
    const sent = attachments
    setValue('')
    setAttachments([])
    setError(null)
    onSend(text, sent)
    ref.current?.focus()
  }

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !busy

  return (
    <div
      className={`composer${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      {attachments.length > 0 && (
        <ul className="attach-list">
          {attachments.map((a) => (
            <li key={a.id} className="attach-chip">
              {a.kind === 'image' && a.url ? (
                <img src={a.url} alt="" className="attach-thumb" />
              ) : (
                <span className="attach-icon">▤</span>
              )}
              <span className="attach-name" title={a.name}>
                {a.name}
              </span>
              <span className="attach-size">{formatSize(a.size)}</span>
              <button
                className="ghost tiny"
                title="Remove"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

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
        <button
          className="ghost tiny attach-btn"
          title="Attach a file"
          onClick={() => fileRef.current?.click()}
          disabled={busy || streaming}
        >
          {busy ? '…' : '＋'}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <ContextBar used={used} total={total} />
        {streaming ? (
          <button className="stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button onClick={submit} disabled={!canSend}>
            Send
          </button>
        )}
      </div>

      {noVision && attachments.some((a) => a.kind === 'image') && (
        <p className="hint warn">
          {model} has no vision projector — it will not see this image.
        </p>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  )
}
