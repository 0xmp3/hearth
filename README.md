# Hearth

A small, local-first chat app. GGUF in, conversation out, nothing else.

*(Name is a placeholder I picked — say the word and I'll rename the folder and package in one step. Alternatives I liked: `lantern`, `kettle`, `nook`, `parlour`, `sift`.)*

## What it is

A desktop-shaped chat window that talks to a local `llama-server` over the OpenAI-compatible API. It does one thing: conversations with a model on your own GPU. No RAG, no tools, no agents, no provider zoo, no settings labyrinth.

The point isn't to beat Chatbox. It's to be small enough that every line is yours, and to learn the parts that are genuinely interesting: SSE streaming, abort handling, local persistence, markdown rendering under load, and later a native shell.

## Status

Planning. No code yet — see [PLAN.md](PLAN.md).

## Backend (verified on this machine, 2026-11-11)

```bash
cd "/c/AI/Llama Rocm"
./llama-server.exe \
  -m "C:/AI/Models/Gemma/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf" \
  --port 8088 -c 8192 -ngl 99 --jinja
```

- Serves `GET /v1/models`, `POST /v1/chat/completions` (stream and non-stream).
- Measured **92 tok/s** generation on the 6.2 GB Gemma — that's the fast iteration model.
- Port **8088** on purpose: Strata holds 8080.
- Big model when we want it: `C:/AI/Models/Deepseek-V4.1-Flash/IQ2_XXS/*00001-of-00006.gguf` (point `-m` at the first shard; llama.cpp stitches splits). *Unverified whether this llama.cpp build knows the `deepseek41` arch — Strata uses its own engine for that pack. Check before relying on it.*

## Running documents

| File | What's in it |
|---|---|
| [PLAN.md](PLAN.md) | Scope, decisions, phases, exit criteria |
| [backlog.md](backlog.md) | Every idea that is not in the current phase |
| [docs/backend.md](docs/backend.md) | The exact HTTP contract we write against, with verified sample responses |
