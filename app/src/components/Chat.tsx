import { useEffect, useRef } from 'react'
import Message from './Message'
import type { Message as Msg } from '../lib/db'

type Props = {
  messages: Msg[]
  streaming: boolean
  showReasoning: boolean
  resolveName: (personaId?: string | null) => string
  userName: string
  onRegenerate: () => void
  onEdit: (text: string) => void
}

export default function Chat({
  messages,
  streaming,
  showReasoning,
  resolveName,
  userName,
  onRegenerate,
  onEdit,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the stream, but stop following the moment the user scrolls up.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // The last user message is never the last message overall — the reply
  // always follows it — so "edit" needs its own index.
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')

  return (
    <div className="chat" ref={scroller}>
      {messages.length === 0 ? (
        <div className="empty">
          <p className="empty-mark">hearth</p>
          <p className="hint">A quiet place to talk to a model on your own machine.</p>
        </div>
      ) : (
        messages.map((m, i) => (
          <Message
            key={m.id}
            message={m}
            streaming={streaming}
            showReasoning={showReasoning}
            resolveName={resolveName}
            userName={userName}
            isLast={i === messages.length - 1}
            isLastUser={i === lastUserIdx}
            onRegenerate={onRegenerate}
            onEdit={onEdit}
          />
        ))
      )}
    </div>
  )
}
