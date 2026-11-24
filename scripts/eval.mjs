// Retrieval evaluation.
//
// Measures how often the message that answers a question is retrieved, with and
// without the cross-encoder reranker, over the corpus in `eval/corpus/`. The
// questions and their gold message ids live in `eval/questions.json`, so the
// numbers are reproducible by anyone who clones the repo — which is the whole
// point. Nothing here is hand-tuned to look good: if the reranker does not help,
// this prints that.
//
//   npm run eval                      # table, plus a pass/fail on hit@3 >= 0.70
//   npm run eval -- --json            # machine-readable
//   npm run eval -- --no-rerank       # embedding stage only
//   npm run eval -- --min-hit3 0.8    # change the gate; 0 disables it
//
// Needs the manager running and an embedding model configured:
//
//   npm run manager                   # or `npm start` for the app as well
//
// The manager is used rather than a direct llama-server call on purpose: it owns
// the query/document prefixes, and scoring queries with the document prefix is
// the quietest way to make retrieval return nothing.

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL = join(HERE, '..', 'eval')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)

const MANAGER = arg('manager', 'http://127.0.0.1:8090')
const TOP_K = Number(arg('top', '10'))
const MIN_HIT3 = Number(arg('min-hit3', '0.7'))
const USE_RERANK = !flag('no-rerank')
const JSON_OUT = flag('json')

const EMBED_BATCH = 64 // the manager's documented limit
const TIMEOUT_MS = 180_000

class EvalError extends Error {}

const HEADERS = { 'Content-Type': 'application/json', 'X-Hearth': '1' }

/** POST to the manager. A 400 from it is an expectation failure, not a crash. */
async function post(path, body) {
  const res = await fetch(MANAGER + path, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      detail = JSON.parse(text).error ?? detail
    } catch {
      /* not json, keep the text */
    }
    throw new EvalError(`${path}: ${res.status} ${detail}`)
  }
  return JSON.parse(text)
}

async function embed(texts, kind) {
  const out = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const slice = texts.slice(i, i + EMBED_BATCH)
    const body = await post('/api/embed', { input: slice, kind })
    if (!Array.isArray(body.vectors) || body.vectors.length !== slice.length) {
      throw new EvalError(`/api/embed returned ${body.vectors?.length} vectors for ${slice.length} inputs`)
    }
    out.push(...body.vectors)
  }
  return out
}

/** Vectors are stored L2-normalised, but score defensively — a bad dot product
 *  is silent, and every number below depends on this being right. */
function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function loadCorpus() {
  const dir = join(EVAL, 'corpus')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  const docs = []
  for (const file of files) {
    const conv = JSON.parse(await readFile(join(dir, file), 'utf8'))
    for (const m of conv.messages) {
      if (!m.id || !m.text) throw new EvalError(`${file}: a message needs an id and text`)
      docs.push({ id: m.id, conversation: conv.id, text: m.text })
    }
  }
  const { questions } = JSON.parse(await readFile(join(EVAL, 'questions.json'), 'utf8'))
  const ids = new Set(docs.map((d) => d.id))
  for (const q of questions) {
    if (q.expect !== null && !ids.has(q.expect)) {
      throw new EvalError(`${q.id}: gold id ${q.expect} is not in the corpus`)
    }
  }
  return { docs, questions }
}

/** Rank positions for one question, given an ordered list of doc ids. */
function positions(ranked, gold) {
  const rank = ranked.indexOf(gold)
  return { rank, hit1: rank === 0, hit3: rank > -1 && rank < 3, rr: rank === -1 ? 0 : 1 / (rank + 1) }
}

function summarise(rows) {
  const n = rows.length
  if (!n) return { n: 0, hit1: 0, hit3: 0, mrr: 0 }
  const hit1 = rows.filter((r) => r.hit1).length / n
  const hit3 = rows.filter((r) => r.hit3).length / n
  const mrr = rows.reduce((s, r) => s + r.rr, 0) / n
  return { n, hit1, hit3, mrr }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`
const pad = (s, w) => String(s).padEnd(w)

async function main() {
  // Fail with a sentence rather than a stack trace when nothing is listening.
  try {
    const res = await fetch(`${MANAGER}/api/embed`, { headers: HEADERS, signal: AbortSignal.timeout(4000) })
    const state = await res.json()
    if (!state?.ready) {
      throw new EvalError(
        `the embedding engine is not ready (${state?.model ?? 'no model configured'}). ` +
          'Set one in Settings → Retrieval, or point embed.model at a GGUF in data/config.json.',
      )
    }
  } catch (err) {
    if (err instanceof EvalError) throw err
    throw new EvalError(`no manager on ${MANAGER} — start it with \`npm run manager\` first`)
  }

  const { docs, questions } = await loadCorpus()
  let rerankOn = false
  if (USE_RERANK) {
    try {
      const state = await fetch(`${MANAGER}/api/rerank`, { headers: HEADERS, signal: AbortSignal.timeout(4000) }).then((r) => r.json())
      rerankOn = Boolean(state?.enabled && state?.ready)
      if (!rerankOn) process.stderr.write('note: reranker not ready — reporting the embedding stage only\n')
    } catch {
      process.stderr.write('note: /api/rerank unavailable — reporting the embedding stage only\n')
    }
  }

  process.stderr.write(`embedding ${docs.length} messages…\n`)
  const docVecs = await embed(docs.map((d) => d.text), 'document')
  process.stderr.write(`embedding ${questions.length} questions…\n`)
  const qVecs = await embed(questions.map((q) => q.question), 'query')

  const answerable = []
  const unanswerable = []
  const rows = []

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const scored = docs
      .map((d, j) => ({ id: d.id, text: d.text, score: cosine(qVecs[i], docVecs[j]) }))
      .sort((a, b) => b.score - a.score)

    const candidates = scored.slice(0, TOP_K)
    let reranked = null
    if (rerankOn) {
      const body = await post('/api/rerank', {
        query: q.question,
        documents: candidates.map((c) => c.text),
        topN: TOP_K,
      })
      // The reranker returns positions into `documents`, descending.
      reranked = body.results.map((r) => candidates[r.index].id)
    }

    const embeddingOrder = candidates.map((c) => c.id)
    const row = {
      id: q.id,
      question: q.question,
      gold: q.expect,
      top1: scored[0].id,
      top1Score: Number(scored[0].score.toFixed(4)),
      embedding: q.expect ? positions(embeddingOrder, q.expect) : null,
      reranked: q.expect && reranked ? positions(reranked, q.expect) : null,
    }
    rows.push(row)
    if (q.expect) answerable.push(row)
    else unanswerable.push({ id: q.id, top1: scored[0].id, score: scored[0].score })
  }

  const base = summarise(answerable.map((r) => r.embedding))
  const withRerank = rerankOn ? summarise(answerable.filter((r) => r.reranked).map((r) => r.reranked)) : null

  const answerableScores = answerable.map((r) => r.top1Score).sort((a, b) => a - b)
  const unanswerableScores = unanswerable.map((u) => u.score).sort((a, b) => a - b)
  const median = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)] : 0)

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          docs: docs.length,
          questions: questions.length,
          answerable: base,
          reranked: withRerank,
          rerankOn,
          unanswerable: {
            n: unanswerable.length,
            medianTop1: Number(median(unanswerableScores).toFixed(4)),
            aboveAnswerableMedian:
              unanswerableScores.filter((s) => s > median(answerableScores)).length,
          },
          rows,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(`\ncorpus ${docs.length} messages · ${questions.length} questions (${answerable.length} answerable, ${unanswerable.length} not)\n`)
    console.log(`${pad('question', 52)} ${pad('gold', 5)} ${pad('emb', 10)} ${pad(rerankOn ? 'rerank' : '', 10)}`)
    console.log('-'.repeat(80))
    for (const r of rows) {
      if (!r.gold) continue
      const show = (p) => (p.hit1 ? 'hit@1' : p.hit3 ? `hit@${p.rank + 1}` : 'miss')
      console.log(
        `${pad(r.question.length > 50 ? r.question.slice(0, 49) + '…' : r.question, 52)} ${pad(r.gold, 5)} ${pad(show(r.embedding), 10)} ${pad(r.reranked ? show(r.reranked) : '', 10)}`,
      )
    }
    console.log()
    const line = (label, s) =>
      console.log(
        `${pad(label, 22)} hit@1 ${pct(s.hit1).padStart(6)}   hit@3 ${pct(s.hit3).padStart(6)}   MRR ${s.mrr.toFixed(3)}   n=${s.n}`,
      )
    line('embedding only', base)
    if (withRerank) line('+ cross-encoder', withRerank)

    console.log(
      `\nunanswerable separation: top-1 cosine median ${median(answerableScores).toFixed(3)} (answerable) vs ` +
        `${median(unanswerableScores).toFixed(3)} (no answer)`,
    )
    const indistinguishable = unanswerableScores.filter((s) => s > median(answerableScores)).length
    console.log(
      `  ${indistinguishable} of ${unanswerableScores.length} unanswerable questions score above the answerable median` +
        (indistinguishable ? ' — a score floor cannot refuse these; the answer stage has to.' : '.'),
    )
  }

  if (MIN_HIT3 > 0) {
    const measured = (withRerank ?? base).hit3
    if (measured + 1e-9 < MIN_HIT3) {
      console.error(`\nFAIL: hit@3 ${pct(measured)} is below the ${pct(MIN_HIT3)} gate`)
      process.exit(1)
    }
    if (!JSON_OUT) console.log(`\nPASS: hit@3 ${pct(measured)} ≥ ${pct(MIN_HIT3)}`)
  }
}

main().catch((err) => {
  console.error(`\neval failed: ${err.message}`)
  process.exit(1)
})
