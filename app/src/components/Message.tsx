import { memo, useEffect, useRef, useState } from 'react'
import Markdown from './Markdown'
import Avatar from './Avatar'
import { extractPreview, type PreviewDoc } from '../lib/preview'
import type { Message as Msg } from '../lib/db'

type Props = {
  message: Msg
  streaming: boolean
  isLast: boolean
  isLastUser: boolean
  showReasoning: boolean
  resolveIdentity: (characterId?: string | null) => { name: string; avatar?: string }
  user: { name: string; avatar?: string }
  onRegenerate: () => void
  onEdit: (text: string) => void
  /** Absent when speech is off or unavailable: no button, no dead control. */
  speech?: { speaking: boolean; starting: boolean; onToggle: () => void }
  /** Pending memories the user has not answered yet, by id. */
  pendingMemoryIds?: Set<string>
  onKeepMemory?: (id: string) => void
  onForgetMemory?: (id: string) => void
  /** Open this reply's page in the preview panel. */
  onPreview?: (doc: PreviewDoc) => void
}

function stamp(ts: number): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

function MessageView({
  message,
  streaming,
  isLast,
  isLastUser,
  showReasoning,
  resolveIdentity,
  user,
  onRegenerate,
  onEdit,
  speech,
  pendingMemoryIds,
  onKeepMemory,
  onForgetMemory,
  onPreview,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)

  // The thinking block is deliberately *uncontrolled*: `open={!content}` looked
  // tidy but React re-applied it on every render, so the block collapsed the
  // moment the answer started and snapped shut again whenever the user opened it
  // to select text. The browser owns the attribute now; we only set it once, and
  // only while the user has not touched it.
  const thinkRef = useRef<HTMLDetailsElement>(null)
  const thinkTouched = useRef(false)
  useEffect(() => {
    const el = thinkRef.current
    if (!el || thinkTouched.current) return
    el.open = !message.content
  }, [message.content])
  const empty = !message.content && !message.reasoning && !message.attachments?.length
  const isUser = message.role === 'user'
  // Only a settled reply is a page: while it streams the fence is half-written,
  // and a half-written document is a blank panel that flickers.
  const page = !isUser && !streaming && message.content ? extractPreview(message.content) : null

  function startEdit() {
    setDraft(message.content)
    setEditing(true)
  }

  return (
    <article className={`msg ${message.role}`}>
      <Avatar
        name={isUser ? user.name : resolveIdentity(message.characterId).name}
        src={isUser ? user.avatar : resolveIdentity(message.characterId).avatar}
      />

      <div className="msg-main">
        {showReasoning && message.reasoning && (
          <details className="reasoning" ref={thinkRef}>
            <summary onClick={() => { thinkTouched.current = true }}>thinking</summary>
            <div>{message.reasoning}</div>
            <button
              className="link"
              onClick={() => void navigator.clipboard.writeText(message.reasoning ?? '')}
            >
              copy thinking
            </button>
          </details>
        )}

        {editing ? (
          <div className="edit">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, draft.split('\n').length + 1)}
              autoFocus
            />
            <div className="edit-row">
              <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
              <button
                onClick={() => {
                  setEditing(false)
                  onEdit(draft)
                }}
                disabled={!draft.trim()}
              >
                Save &amp; resend
              </button>
            </div>
          </div>
        ) : (
          <div className="body">
            {message.attachments?.length ? (
              <ul className="msg-attachments">
                {message.attachments.map((a) => (
                  <li key={a.id} className={`msg-attachment ${a.kind}`}>
                    {a.kind === 'image' && a.url ? (
                      <img src={a.url} alt={a.name} className="msg-image" />
                    ) : (
                      <>
                        <span className="attach-icon">▤</span>
                        <span className="attach-name">{a.name}</span>
                        {a.truncated && <span className="footnote warn">truncated</span>}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {message.tools?.length ? (
              <ul className="msg-tools">
                {message.tools.map((t, i) => (
                  <li key={i} className={t.ok ? 'tool-ok' : 'tool-bad'}>
                    {t.name === 'remember' && t.memoryId && pendingMemoryIds?.has(t.memoryId) ? (
                      <span className="remember-offer">
                        remember “{t.summary}”?
                        <button className="link" onClick={() => onKeepMemory?.(t.memoryId!)}>
                          keep
                        </button>
                        <button className="link" onClick={() => onForgetMemory?.(t.memoryId!)}>
                          forget
                        </button>
                      </span>
                    ) : t.name === 'remember' ? (
                      t.summary === 'already known' ? 'memory: already known' : `memory: ${t.summary}`
                    ) : (
                      `${t.name}: ${t.summary}`
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {isUser ? (
              message.content
            ) : message.content ? (
              <Markdown text={message.content} />
            ) : empty && streaming ? (
              <span className="dots">…</span>
            ) : empty && !isUser ? (
              <span className="footnote">no reply</span>
            ) : null}
          </div>
        )}

        {!editing && (
          <div className="msg-actions">
            <span className="footnote">{stamp(message.createdAt)}</span>
            {message.aborted && <span className="footnote">stopped</span>}
            {message.truncated && (
              <span className="footnote warn">ran out of tokens</span>
            )}
            {message.stats?.tokPerSec && (
              <span className="footnote">
                {message.stats.tokPerSec.toFixed(1)} tok/s
                {message.stats.completionTokens ? ` · ${message.stats.completionTokens} tokens` : ''}
              </span>
            )}
            {message.content && (
              <button className="link" onClick={() => void navigator.clipboard.writeText(message.content)}>
                copy
              </button>
            )}
            {page && (
              <button className="link" onClick={() => onPreview?.(page)} title="Open this page beside the chat">
                preview
              </button>
            )}
            {isUser && isLastUser && !streaming && (
              <button className="link" onClick={startEdit}>edit</button>
            )}
            {!isUser && isLast && !streaming && (
              <button className="link" onClick={onRegenerate}>regenerate</button>
            )}
            {!isUser && speech && message.content && !streaming && (
              <button className="link" onClick={speech.onToggle}>
                {speech.speaking ? (speech.starting ? 'starting…' : 'stop') : 'speak'}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

export default memo(MessageView)
