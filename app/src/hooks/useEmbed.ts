// Whether retrieval is possible, and whether it is any good.
//
// Two engines, two questions, and they are not the same:
//
//   ready       — an embedding model is configured, so a conversation can be indexed
//   rerankReady — a cross-encoder is configured, so a search can be reordered
//
// The second is optional on purpose. Without it retrieval still works, just
// worse: measured, the right answer landed in the top 3 for 6 of 6 questions with
// a reranker and 3 of 6 without. The UI says which one it is getting rather than
// pretending they are the same feature.

import { useCallback, useEffect, useState } from 'react'
import { manager, type EmbedState, type RerankState } from '../lib/backend'
import { countVectors } from '../lib/db'

export function useEmbed() {
  const [embed, setEmbed] = useState<EmbedState | null>(null)
  const [rerank, setRerank] = useState<RerankState | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [indexed, setIndexed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [e, r, count] = await Promise.all([manager.embedState(), manager.rerankState(), countVectors()])
      setEmbed(e)
      setRerank(r)
      setIndexed(count)
      setAvailable(true)
      setError(null)
    } catch {
      // No manager means no retrieval. Failing closed is the right direction:
      // the tool is then simply not declared.
      setAvailable(false)
      setEmbed(null)
      setRerank(null)
      setIndexed(0)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // The manager owns both engines and can be reconfigured from Settings in
    // another tab, so re-read on focus rather than trusting a stale copy.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return {
    embed,
    rerank,
    available,
    /** An embedding model is configured: conversations can be indexed. */
    ready: Boolean(embed?.enabled && embed.ready),
    /** A reranker is configured: searches are reordered by a cross-encoder. */
    rerankReady: Boolean(rerank?.enabled && rerank.ready),
    /** How many vectors exist, i.e. whether anything is searchable at all. */
    indexed,
    refresh,
    error,
  }
}
