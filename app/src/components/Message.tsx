import { memo } from 'react'
import type { Message as Msg } from '../lib/db'

type Props = { message: Msg; streaming: boolean }

function MessageView({ message, streaming }: Props) {
  const empty = !message.content && !message.reasoning

  return (
    <article className={`msg ${message.role}`}>
      {message.reasoning && (
        <details className="reasoning" open={!message.content}>
          <summary>thinking</summary>
          <div>{message.reasoning}</div>
        </details>
      )}

      <div className="body">
        {message.content || (empty && streaming ? <span className="dots">…</span> : null)}
      </div>

      {message.aborted && <div className="footnote">stopped</div>}
      {message.stats?.tokPerSec && (
        <div className="footnote">
          {message.stats.tokPerSec.toFixed(1)} tok/s
          {message.stats.completionTokens ? ` · ${message.stats.completionTokens} tokens` : ''}
        </div>
      )}
    </article>
  )
}

export default memo(MessageView)
