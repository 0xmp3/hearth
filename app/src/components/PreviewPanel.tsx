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
 * What the panel puts in the frame in place of a page that tried to leave.
 *
 * No scripts, no sandbox allowance: the point is that the document that moved is
 * gone. It is a document for someone else's page, so it follows the OS colour
 * scheme rather than Hearth's theme, exactly like the wrapper in lib/preview.ts.
 */
const BLOCKED_DOC = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root { color-scheme: light dark; }
html, body { margin: 0; }
body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; }
h1 { font-size: 16px; margin: 0 0 8px; }
p { margin: 0; opacity: 0.75; }
</style></head>
<body>
<h1>This page tried to load another address.</h1>
<p>The preview stopped it and reset the panel. Nothing was read from this app.</p>
</body>
</html>`

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
 *
 * There is one channel neither layer closes: **the page can navigate itself.**
 * `navigate-to` was never shipped by any browser, and a `<meta refresh>` is not
 * governed by a CSP directive at all, so `location = 'https://host/?d=…'` leaves
 * the frame and the request is made. That cannot be prevented here, so it is
 * detected: the iframe's `load` event fires again when the document moves, and a
 * second load means the page we vetted is no longer the page in the frame. The
 * frame is then replaced with a static notice — not re-run, because a page that
 * navigates would do it again on every reload.
 */
export default function PreviewPanel({ doc, width, onWidth, onClose }: Props) {
  // Remounting the iframe is the only reliable reload: a sandboxed document
  // cannot be asked to reload itself, and reusing the element keeps the old
  // document alive.
  const [nonce, setNonce] = useState(0)
  const [copied, setCopied] = useState(false)
  // True when the page left the document we handed it; the frame then holds the
  // static notice instead of the reply's page.
  const [left, setLeft] = useState(false)
  // The drag is local and only committed on release: writing a preference on
  // every pointermove is a localStorage write per frame.
  const [w, setW] = useState(() => clamp(width))
  // Commit needs the width from *this* drag, not from the render the handler
  // closed over — React batches the moves, so `w` in the pointerup closure is
  // still the pre-drag value and the drag silently failed to persist.
  const live = useRef(w)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  // Loads since this element was created. The first is our own document.
  const loads = useRef(0)

  const frameLoad = useCallback(() => {
    loads.current += 1
    if (loads.current === 1) return
    // Second load: the document moved — a navigation, or a reload of itself.
    // Either way it is no longer the page we vetted, so it is replaced.
    loads.current = 0
    setLeft(true)
  }, [])

  const runAgain = useCallback(() => {
    loads.current = 0
    setLeft(false)
    setNonce((n) => n + 1)
  }, [])

  // A new page means a fresh count: the srcDoc change is itself a load.
  useEffect(() => {
    loads.current = 0
    setLeft(false)
  }, [doc.html])

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

      {left && (
        <p className="preview-note preview-note-nav">
          This page tried to load another address, so the preview stopped it and reset the frame.{' '}
          <button className="link" onClick={runAgain}>
            run it again
          </button>
        </p>
      )}

      {doc.external.length > 0 && (
        <p className="preview-note">
          This page asks for {doc.external.join(', ')} — external assets are blocked, so it may
          render blank.
        </p>
      )}

      <iframe
        key={left ? 'blocked' : nonce}
        className="preview-frame"
        title={doc.title}
        // Never allow-same-origin. The blocked document gets the same allowance
        // because it carries no script at all — changing the attribute per state
        // would only make the sandbox harder to read from outside.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={left ? BLOCKED_DOC : doc.html}
        onLoad={frameLoad}
      />
    </aside>
  )
}
