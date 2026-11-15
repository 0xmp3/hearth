import { useCallback, useEffect, useRef, useState } from 'react'
import {
  manager,
  type EmbedState,
  type RerankDownloadState,
  type RerankState,
} from '../lib/backend'

// Retrieval Settings: the two engines behind `search_history`.
//
// Two processes, and they are not the same feature:
//
//   embedding  — turns a message into 768 numbers. Without it nothing can be indexed.
//   reranking  — a cross-encoder that reads the query and the candidate together.
//                Optional, and the difference between "the answer is in the top 3"
//                for 3 of 6 questions and for 6 of 6.
//
// Both start on demand and stop after ten idle minutes, so this panel says which
// state each is in — "no results" and "still loading 600 MB" look identical
// otherwise. The reranker is a file the app has to fetch itself, so it gets the
// same treatment as the engine: a pinned digest, verified before it is used.

type Props = {
  /** Called when either engine's state changes, so the app can re-read readiness. */
  onState?: () => void
}

function megabytes(bytes: number) {
  return `${(bytes / 1e6).toFixed(0)} MB`
}

export default function RetrievalPanel({ onState }: Props) {
  const [embed, setEmbed] = useState<EmbedState | null>(null)
  const [rerank, setRerank] = useState<RerankState | null>(null)
  const [downloads, setDownloads] = useState<RerankDownloadState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState('')
  const [rModel, setRModel] = useState('')
  const [ngl, setNgl] = useState('99')
  const [rNgl, setRNgl] = useState('0')
  const [candidates, setCandidates] = useState('10')
  const poll = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [e, r, d] = await Promise.all([
        manager.embedState(),
        manager.rerankState(),
        manager.rerankDownloads(),
      ])
      setEmbed(e)
      setRerank(r)
      setDownloads(d)
      setModel(e.model.path)
      setRModel(r.model.path)
      setNgl(String(e.ngl))
      setRNgl(String(r.ngl))
      setCandidates(String(r.candidates))
      setError(null)
      onState?.()
      return d
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }, [onState])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A download is a two-minute job, so the panel polls while one is running and
  // stops the moment it is not. Polling forever would be a timer nobody asked for.
  useEffect(() => {
    const running = downloads?.progress.phase === 'downloading' || downloads?.progress.phase === 'verifying'
    if (!running) {
      if (poll.current) {
        window.clearInterval(poll.current)
        poll.current = null
      }
      return
    }
    if (poll.current) return
    poll.current = window.setInterval(() => void refresh(), 1000)
    return () => {
      if (poll.current) {
        window.clearInterval(poll.current)
        poll.current = null
      }
    }
  }, [downloads?.progress.phase, refresh])

  async function act(fn: () => Promise<unknown>, unable?: string) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(unable ?? (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const progress = downloads?.progress
  const percent = progress && progress.total ? Math.round((progress.got / progress.total) * 100) : 0

  return (
    <div className="character-form">
      {!embed || !rerank ? (
        <p className="hint">{error ?? 'looking for the manager…'}</p>
      ) : (
        <>
          <p className="hint">
            Indexing is opt-in per conversation — the toggle is in “This conversation”. Once a chat
            is indexed, the model can search it from anywhere, including after the beginning has
            been summarised away. Nothing leaves this machine.
          </p>

          <h4>Embedding</h4>
          <label className="check">
            <input
              type="checkbox"
              checked={embed.enabled}
              disabled={busy}
              onChange={(e) => void act(() => manager.saveEmbed({ enabled: e.target.checked }))}
            />
            Index conversations
          </label>

          <p className="hint">
            {embed.serverRunning
              ? `engine warm on port ${embed.port}`
              : embed.enabled
                ? 'engine starts on the first search'
                : 'the engine stays off until this is on'}
            {embed.error ? ` · ${embed.error}` : ''}
          </p>

          <label className="field">
            <span>Embedding model (GGUF)</span>
            <input
              value={model}
              placeholder="embeddinggemma-300m-qat-Q8_0.gguf"
              disabled={busy}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => void act(() => manager.saveEmbed({ model }))}
            />
          </label>

          <div className="row">
            <label className="field">
              <span>GPU layers</span>
              <input
                type="number"
                min={0}
                max={999}
                value={ngl}
                disabled={busy}
                onChange={(e) => setNgl(e.target.value)}
                onBlur={() => void act(() => manager.saveEmbed({ ngl: Number(ngl) }))}
              />
            </label>
            <label className="field">
              <span>Pooling</span>
              <select
                value={embed.pooling}
                disabled={busy}
                onChange={(e) => void act(() => manager.saveEmbed({ pooling: e.target.value }))}
              >
                {['mean', 'cls', 'last', 'none'].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <details className="reasoning">
            <summary>Task prompts</summary>
            <p className="hint">
              Prefixed to every text before it is embedded, and they are not the same for a
              document and a query. These are EmbeddingGemma’s; a different model wants different
              ones, or none. Changing either invalidates the index and it will ask to be rebuilt.
            </p>
            <label className="field">
              <span>Document prefix</span>
              <input
                value={embed.prefix}
                disabled={busy}
                onChange={(e) => void act(() => manager.saveEmbed({ prefix: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Query prefix</span>
              <input
                value={embed.queryPrefix}
                disabled={busy}
                onChange={(e) => void act(() => manager.saveEmbed({ queryPrefix: e.target.value }))}
              />
            </label>
          </details>

          <h4>Reranking</h4>
          <p className="hint">
            A second model that reads the query and each candidate together, then reorders them.
            Measured on two fixtures: without it the right message was in the top 3 for 3 of 6
            questions, with it for 6 of 6. It runs on the CPU by default — 42 ms on the GPU against
            622 ms on the CPU for 20 candidates — because the GPU belongs to the chat model.
          </p>

          <label className="check">
            <input
              type="checkbox"
              checked={rerank.enabled}
              disabled={busy}
              onChange={(e) => void act(() => manager.saveRerank({ enabled: e.target.checked }))}
            />
            Reorder search results with a reranker
          </label>

          <p className="hint">
            {rerank.serverRunning
              ? `engine warm on port ${rerank.port}`
              : rerank.enabled
                ? 'engine starts on the first search'
                : 'searches are ordered by embedding similarity alone'}
            {rerank.error ? ` · ${rerank.error}` : ''}
          </p>

          <label className="field">
            <span>Reranker model (GGUF)</span>
            <input
              value={rModel}
              placeholder="bge-reranker-v2-m3-Q8_0.gguf"
              disabled={busy}
              onChange={(e) => setRModel(e.target.value)}
              onBlur={() => void act(() => manager.saveRerank({ model: rModel }))}
            />
          </label>

          <div className="row">
            <label className="field">
              <span>GPU layers</span>
              <input
                type="number"
                min={0}
                max={999}
                value={rNgl}
                disabled={busy}
                onChange={(e) => setRNgl(e.target.value)}
                onBlur={() => void act(() => manager.saveRerank({ ngl: Number(rNgl) }))}
              />
            </label>
            <label className="field">
              <span>Candidates</span>
              <input
                type="number"
                min={1}
                max={64}
                value={candidates}
                disabled={busy}
                onChange={(e) => setCandidates(e.target.value)}
                onBlur={() => void act(() => manager.saveRerank({ candidates: Number(candidates) }))}
              />
            </label>
          </div>

          <h4>Download a reranker</h4>
          <p className="hint">
            Fetched from Hugging Face and checked against a pinned SHA-256 before it is used — an
            unverified file is refused, not warned about. {downloads?.dir}
          </p>

          {progress && progress.phase !== 'idle' && (
            <p className="hint">
              {progress.phase === 'downloading'
                ? `downloading ${progress.file ?? ''} — ${megabytes(progress.got)} of ${megabytes(progress.total)} (${percent}%)`
                : progress.phase === 'verifying'
                  ? 'verifying the checksum…'
                  : progress.phase === 'done'
                    ? 'installed and selected'
                    : `failed: ${progress.error ?? 'unknown error'}`}
            </p>
          )}

          <ul className="character-list">
            {(downloads?.entries ?? []).map((entry) => (
              <li key={entry.id}>
                <span className="character-pick">
                  <span className="character-name">{entry.name}</span>
                  <span className="character-note">
                    {megabytes(entry.size)} · {entry.note}
                    {entry.installed ? ' · on disk' : ''}
                  </span>
                </span>
                <button
                  className="link"
                  disabled={busy || progress?.phase === 'downloading' || progress?.phase === 'verifying'}
                  onClick={() =>
                    void act(
                      () =>
                        entry.installed
                          ? manager.saveRerank({ model: entry.path, enabled: true })
                          : manager.downloadReranker(entry.id),
                      entry.installed ? 'that model could not be selected' : 'that download could not start',
                    )
                  }
                >
                  {entry.installed
                    ? rModel.replace(/\\/g, '/').endsWith(entry.file)
                      ? 'in use'
                      : 'use this'
                    : 'download'}
                </button>
              </li>
            ))}
          </ul>

          {!rerank.ready && rerank.enabled && (
            <p className="hint">
              Reranking is on but no model is set, so searches fall back to embedding order. Download
              one above, or point the field at a GGUF you already have.
            </p>
          )}

          {error && <p className="hint warn">{error}</p>}
        </>
      )}
    </div>
  )
}
