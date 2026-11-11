import { useEffect, useMemo, useRef, useState } from 'react'
import type { Conversation, SearchHit } from '../lib/db'

export type PaletteAction = {
  id: string
  label: string
  hint?: string
  run: () => void
}

type Props = {
  open: boolean
  onClose: () => void
  actions: PaletteAction[]
  conversations: Conversation[]
  onSelect: (id: string) => void
  search: (query: string) => Promise<SearchHit[]>
}

type Item = { key: string; label: string; sub: string; run: () => void }

export default function Palette({ open, onClose, actions, conversations, onSelect, search }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset on open, and focus after the element exists.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setActive(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  // Debounced body search. Titles and commands filter synchronously.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const t = window.setTimeout(async () => {
      const result = query.trim() ? await search(query) : []
      if (!cancelled) setHits(result)
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, open, search])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const matchedActions = actions.filter((a) => !q || a.label.toLowerCase().includes(q))
    const matchedConvs = conversations
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .slice(0, 8)

    return [
      ...matchedActions.map((a) => ({
        key: `action:${a.id}`,
        label: a.label,
        sub: a.hint ?? '',
        run: a.run,
      })),
      ...matchedConvs.map((c) => ({
        key: `conv:${c.id}`,
        label: c.title,
        sub: 'conversation',
        run: () => onSelect(c.id),
      })),
      ...hits.map((h) => ({
        key: `msg:${h.messageId}`,
        label: h.snippet,
        sub: h.role,
        run: () => onSelect(h.conversationId),
      })),
    ]
  }, [query, actions, conversations, hits, onSelect])

  useEffect(() => {
    setActive(0)
  }, [query])

  if (!open) return null

  function runAt(index: number) {
    const item = items[index]
    if (!item) return
    item.run()
    onClose()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              runAt(active)
            }
          }}
          placeholder="Search conversations and messages, or run a command…"
          spellCheck={false}
        />

        <ul className="palette-list">
          {items.length === 0 && <li className="palette-empty">Nothing matches.</li>}
          {items.map((item, i) => (
            <li
              key={item.key}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                runAt(i)
              }}
            >
              <span className="palette-label">{item.label}</span>
              {item.sub && <span className="palette-sub">{item.sub}</span>}
            </li>
          ))}
        </ul>

        <div className="palette-foot">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
