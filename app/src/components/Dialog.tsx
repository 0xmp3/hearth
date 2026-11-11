import type { ReactNode } from 'react'

type Props = {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

// Esc is handled by App, which knows whether a dialog is open — one place
// decides what Escape means instead of every dialog fighting over it.
export default function Dialog({ title, onClose, children, footer, wide }: Props) {
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className={`dialog${wide ? ' wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="ghost tiny" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  )
}
