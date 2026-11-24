# Retrieval evaluation

Measures whether the message that answers a question is actually retrieved, with and
without the cross-encoder reranker. The corpus and the gold labels are committed, so
`npm run eval` reproduces every number below on a fresh clone.

```bash
npm run manager            # in another terminal: the manager owns the embed/rerank engines
npm run eval               # table + pass/fail on hit@3 >= 0.70
npm run eval -- --json     # machine-readable, nothing else on stdout
npm run eval -- --no-rerank
npm run eval -- --min-hit3 0.8
```

Requires Node 24, a manager on `:8090`, and an embedding model configured in
Settings → Retrieval. The reranker is optional; without it the embedding stage is
reported alone.

## What it measures

- **hit@1 / hit@3** — is the gold message the first result, or in the first three
- **MRR** — mean reciprocal rank, so a near-miss is scored better than a miss
- **unanswerable separation** — whether top-1 scores distinguish questions the corpus
  cannot answer. Retrieval cannot refuse on its own; this reports whether a score floor
  would even be measurable, instead of pretending a refusal rate.

## The corpus

`eval/corpus/*.json` — three conversations, 45 messages total, written for this purpose
so they can be published. Three topics share vocabulary on purpose: a ferry and a quay
appear in a travel conversation *and* in a shipping-client incident; "Lighthouse" is a
monitoring stack in one conversation and a project codename in another. Without those
collisions the eval would be measuring keyword lookup.

`eval/questions.json` — 30 questions: 22 answerable with a single gold message id, and
8 that have no answer anywhere in the corpus.

## Current numbers — 24 Nov 2026

Corpus 45 messages, 22 answerable questions, 8 unanswerable. Embedding: EmbeddingGemma
300m Q8_0. Reranker: bge-reranker-v2-m3 Q8_0, top-10 candidates.

| stage | hit@1 | hit@3 | MRR |
|---|---|---|---|
| embedding only | 77.3% (17/22) | 86.4% (19/22) | 0.836 |
| + cross-encoder | **81.8% (18/22)** | 86.4% (19/22) | **0.859** |

95% Clopper–Pearson intervals on this sample: hit@1 59.7–94.8%, hit@3 65.1–97.1%. At
n=22 one question is worth 4.5 points, so these intervals are wide and the honest
statement is "hit@3 somewhere between 65% and 97%". The number is real; the precision
is not. Growing the set is what buys precision, not re-running it.

Unanswerable separation: top-1 cosine median 0.699 for answerable questions vs 0.558 for
unanswerable ones; 0 of 8 unanswerable questions scored above the answerable median.

Read that honestly: **the reranker buys rank-1, not recall.** It moved hit@1 by 4.5
points and MRR by 0.023, and it left hit@3 unchanged because it never recovered a
document the embedding stage had missed — it only reordered what was already there. On
a set of 22, one question is worth 4.5 points, so the hit@1 improvement is one question.

## The three misses, audited

Labels are a source of error too, so every miss gets read before the number is believed.

| question | gold | retrieved | verdict |
|---|---|---|---|
| "What causes the connection exhaustion at Harbour Freight?" | b3 | b1 | **Genuine miss.** b1 reports the incident; only b3 states the cause. Single-message granularity, no neighbouring context. |
| "Why is the dashboard query slow on the events table?" | c3 | c1 | **Ambiguous label.** c1 says "40 million rows, 11 seconds" — a defensible answer. c3 has the actual cause (sequential scan). Left as-is rather than relabelled after seeing the result. |
| "Which index fixed the dashboard query?" | c5 | c9 | **Genuine miss.** c9 says the index is being kept, not that it fixed anything. |

And one rerank regression: for "what did the composite index cost on the write path"
the gold message sat at rank 2 for the embedding stage and rank 3 after reranking. The
cross-encoder demoted a correct document. That is worth knowing before trusting a
reranker on a short, dense corpus.

## The rule this file exists to enforce

**Do not retune a question after seeing the result.** The ambiguous label above stays
ambiguous and stays in the denominator. If a label is ever changed, the change gets a
line here with the reason and the number before and after — otherwise the eval becomes a
record of what you tuned, not of what the system does.
