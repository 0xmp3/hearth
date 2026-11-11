import { memo, useState } from 'react'
import Markdown from './Markdown'
import Avatar from './Avatar'
import type { Message as Msg } from '../lib/db'

type Props = {
  message: Msg
  streaming: boolean
  isLast: boolean
  isLastUser: boolean
  showReasoning: boolean
  resolveIdentity: (personaId?: string | null) => { name: string; avatar?: string }
  user: { name: string; avatar?: string }
  onRegenerate: () => void
  onEdit: (text: string) => void
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
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const empty = !message.content && !message.reasoning
  const isUser = message.role === 'user'

  function startEdit() {
    setDraft(message.content)
    setEditing(true)
  }

  return (
    <article className={`msg ${message.role}`}>
      <Avatar
        name={isUser ? user.name : resolveIdentity(message.personaId).name}
        src={isUser ? user.avatar : resolveIdentity(message.personaId).avatar}
      />

      <div className="msg-main">
        {showReasoning && message.reasoning && (
          <details className="reasoning" open={!message.content}>
            <summary>thinking</summary>
            <div>{message.reasoning}</div>
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
            {isUser ? (
              message.content
            ) : message.content ? (
              <Markdown text={message.content} />
            ) : empty && streaming ? (
              <span className="dots">…</span>
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
            {isUser && isLastUser && !streaming && (
              <button className="link" onClick={startEdit}>edit</button>
            )}
            {!isUser && isLast && !streaming && (
              <button className="link" onClick={onRegenerate}>regenerate</button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

export default memo(MessageView)
