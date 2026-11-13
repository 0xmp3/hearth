import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreviewDoc } from '../lib/preview'

type Props = {
  doc: PreviewDoc
  width: number
  onWidth: (width: number) => void
  onClose: () => void
}

const MIN = 320
const MAX = 1100

function clamp(width: number): number {
  // Half the window, not most of it: the chat has to stay readable while the
  // panel is open, and a preview is a companion, not the main event.
  const ceiling = Math.min(MAX, Math.round(window.innerWidth * 0.55))
  return Math.max(MIN, Math.min(ceiling, Math.round(width)))
}

/**
 * The page a reply produced, beside the chat.
 *
 * The iframe is the whole security story and it is deliberately the smallest
 * possible surface:
 *
 *   sandbox="allow-scripts"   — and never allow-same-origin. Without it the
 *                               document gets an opaque origin, so indexedDB,
 *                               localStorage, cookies and the parent's DOM all
 *                               throw. With it, the page would be same-origin
 *                               with the app and could read every conversation.
 *   no allow-popups           — window.open is refused.
 *   no allow-top-navigation   — the page cannot navigate the app away.
 *   no allow-forms            — a form cannot submit, on top of form-action 'none'.
 *
 * The CSP inside the document (lib/preview.ts) removes the network. Neither
 * layer is sufficient alone: the sandbox stops origin access, the CSP stops
 * exfiltration, and a page that beats one still meets the other.
 */
export default function PreviewPanel({ doc, width, onWidth, onClose }: Props) {
  // Remounting the iframe is the only reliable reload: a sandboxed document
  // cannot be asked to reload itself, and reusing the element keeps the old
  // document alive.
  const [nonce, setNonce] = useState(0)
  const [copied, setCopied] = useState(false)
  // The drag is local and only committed on release: writing a preference on
  // every pointermove is a localStorage write per frame.
  const [w, setW] = useState(() => clamp(width))
  // Commit needs the width from *this* drag, not from the render the handler
  // closed over — React batches the moves, so `w` in the pointerup closure is
  // still the pre-drag value and the drag silently failed to persist.
  const live = useRef(w)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const resize = useCallback((next: number) => {
    const value = clamp(next)
    live.current = value
    setW(value)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    drag.current = { startX: e.clientX, startWidth: live.current }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      // Dragging left widens the panel, because the handle is on its left edge.
      resize(d.startWidth - (e.clientX - d.startX))
    },
    [resize],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return
      drag.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      onWidth(live.current)
    },
    [onWidth],
  )

  // A window that shrinks under a wide panel would push the chat off screen.
  useEffect(() => {
    const onResize = () => resize(live.current)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [resize])

  async function copy() {
    try {
      await navigator.clipboard.writeText(doc.html)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard blocked — the button simply does nothing
    }
  }

  return (
    <aside className="preview" aria-label="Page preview" style={{ width: w }}>
      <div
        className="preview-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      <header className="preview-bar">
        <span className="preview-title" title={doc.title}>
          {doc.title}
        </span>
        <div className="preview-actions">
          <button className="link" onClick={() => setNonce((n) => n + 1)} title="Run the page again">
            reload
          </button>
          <button className="link" onClick={() => void copy()} title="Copy the assembled document">
            {copied ? 'copied' : 'copy html'}
          </button>
          <button className="link" onClick={onClose} title="Close the preview">
            close
          </button>
        </div>
      </header>

      {doc.external.length > 0 && (
        <p className="preview-note">
          This page asks for {doc.external.join(', ')} — external assets are blocked, so it may
          render blank.
        </p>
      )}

      <iframe
        key={nonce}
        className="preview-frame"
        title={doc.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={doc.html}
      />
    </aside>
  )
}
