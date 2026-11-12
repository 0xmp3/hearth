import { useRef, useState } from 'react'
import Dialog from './Dialog'
import { parseBackup } from '../lib/export'
import type { Backup } from '../lib/db'

type Props = {
  onClose: () => void
  onRestore: (backup: Backup, ids: string[]) => Promise<void>
}

export default function RestoreDialog({ onClose, onRestore }: Props) {
  const [backup, setBackup] = useState<Backup | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function choose(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      const parsed = parseBackup(await file.text())
      setBackup(parsed)
      setSelected(new Set(parsed.conversations.map((c) => c.id)))
    } catch (err) {
      setBackup(null)
      setError((err as Error).message)
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = backup ? selected.size === backup.conversations.length : false

  return (
    <Dialog
      title="Restore"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button
            disabled={!backup || selected.size === 0 || busy}
            onClick={async () => {
              if (!backup) return
              setBusy(true)
              try {
                await onRestore(backup, [...selected])
                onClose()
              } catch (err) {
                setError((err as Error).message)
                setBusy(false)
              }
            }}
          >
            {busy ? 'Restoring…' : `Restore ${selected.size || ''}`.trim()}
          </button>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={choose}
      />

      {!backup ? (
        <>
          <p className="hint">
            Choose a Hearth backup file. You can restore everything in it, or pick
            individual conversations.
          </p>
          <div className="row">
            <button onClick={() => fileRef.current?.click()}>Choose file…</button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            {backup.conversations.length} conversation
            {backup.conversations.length === 1 ? '' : 's'} in this file
            {backup.characters?.length ? `, ${backup.characters.length} profile${backup.characters.length === 1 ? '' : 's'}` : ''}
            . Restoring merges by id — nothing already here is deleted.
          </p>

          <div className="row between">
            <button
              className="link"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(backup.conversations.map((c) => c.id)))
              }
            >
              {allSelected ? 'select none' : 'select all'}
            </button>
            <button className="link" onClick={() => fileRef.current?.click()}>choose another file</button>
          </div>

          <ul className="picker-list">
            {backup.conversations.map((c) => (
              <li key={c.id} className={selected.has(c.id) ? 'active' : ''} onClick={() => toggle(c.id)}>
                <input type="checkbox" checked={selected.has(c.id)} readOnly />
                <span>{c.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <div className="error">{error}</div>}
    </Dialog>
  )
}
