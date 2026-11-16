import { useEffect, useRef } from 'react'
import Message from './Message'
import type { PreviewDoc } from '../lib/preview'
import type { Message as Msg, TextStyle } from '../lib/db'

type Props = {
  messages: Msg[]
  streaming: boolean
  showReasoning: boolean
  resolveIdentity: (characterId?: string | null) => { name: string; avatar?: string }
  user: { name: string; avatar?: string }
  onRegenerate: () => void
  onEdit: (text: string) => void
  /** Undefined when speech is off: the per-message button then never renders. */
  speech?: { speakingId: string | null; starting: boolean; onToggle: (message: Msg) => void }
  pendingMemoryIds?: Set<string>
  onKeepMemory?: (id: string) => void
  onForgetMemory?: (id: string) => void
  onPreview?: (doc: PreviewDoc) => void
  /** How this conversation dresses emphasis. */
  fx?: TextStyle
  /** The hue a message's character writes in, if it has one. */
  hueFor?: (characterId?: string | null) => number | undefined
  /** Open the message a reply cited. */
  onJumpToSource?: (conversationId: string, messageId: string) => void
  /** A message to scroll to, set when a citation chip is clicked. */
  jumpTo?: string | null
  /** No model is loaded, so the empty state has to say what to do about it. */
  noModels?: boolean
}

export default function Chat({
  messages,
  streaming,
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
  fx,
  hueFor,
  onJumpToSource,
  jumpTo,
  noModels,
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

  // A citation chip asks for a specific message. It may arrive before the
  // conversation has loaded, so this runs on `messages` too and simply does
  // nothing until the element exists.
  useEffect(() => {
    if (!jumpTo) return
    const el = scroller.current?.querySelector(`[data-message-id="${jumpTo}"]`)
    if (!el) return
    // Stop following the stream: the user asked to look at something specific.
    pinned.current = false
    el.scrollIntoView({ block: 'center' })
  }, [jumpTo, messages])

  // The last user message is never the last message overall — the reply
  // always follows it — so "edit" needs its own index.
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')

  return (
    <div className="chat" ref={scroller}>
      {messages.length === 0 ? (
        <div className="empty">
          <p className="empty-mark">hearth</p>
          <p className="hint">A quiet place to talk to a model on your own machine.</p>
          {noModels && (
            <p className="hint">
              No model is loaded yet. Settings → Backend can download one (4.6 GB, verified), or
              point the app at a <code>llama-server</code> you already run.
            </p>
          )}
        </div>
      ) : (
        messages.map((m, i) => (
          <Message
            key={m.id}
            message={m}
            streaming={streaming}
            showReasoning={showReasoning}
            resolveIdentity={resolveIdentity}
            user={user}
            isLast={i === messages.length - 1}
            isLastUser={i === lastUserIdx}
            onRegenerate={onRegenerate}
            onEdit={onEdit}
            pendingMemoryIds={pendingMemoryIds}
            onKeepMemory={onKeepMemory}
            onForgetMemory={onForgetMemory}
            onPreview={onPreview}
            fx={fx}
            hue={hueFor?.(m.characterId)}
            onJumpToSource={onJumpToSource}
            speech={
              speech
                ? {
                    speaking: speech.speakingId === m.id,
                    starting: speech.starting && speech.speakingId === m.id,
                    onToggle: () => speech.onToggle(m),
                  }
                : undefined
            }
          />
        ))
      )}
    </div>
  )
}
