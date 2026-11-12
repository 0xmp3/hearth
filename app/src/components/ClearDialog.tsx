import Dialog from './Dialog'

// The one destructive action that is not about a single thing.
//
// It says exactly what goes and what stays, because "clear all chats" could
// reasonably mean either "empty the list" or "factory reset", and only one of
// those is what this does. The button repeats the count so a mis-click is
// visible before it lands.

type Props = {
  conversations: number
  messages: number
  onConfirm: () => void
  onClose: () => void
}

export default function ClearDialog({ conversations, messages, onConfirm, onClose }: Props) {
  const nothing = conversations === 0
  return (
    <Dialog
      title="Clear all chats"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="danger" onClick={onConfirm} disabled={nothing}>
            {nothing ? 'Nothing to clear' : `Delete ${conversations} conversation${conversations === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <p className="hint">
        {nothing
          ? 'There are no conversations to delete.'
          : `${conversations} conversation${conversations === 1 ? '' : 's'} and ${messages} message${
              messages === 1 ? '' : 's'
            } will be deleted from this machine.`}
      </p>
      <p className="hint">
        Your profiles, characters, prompt library and the facts it remembers about you stay. Summaries
        and anything remembered inside a conversation go with the thread they belong to.
      </p>
      <p className="hint">This cannot be undone — export first if you want a copy.</p>
    </Dialog>
  )
}
