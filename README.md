# Hearth

A small, local-first chat app. GGUF in, conversation out, nothing else.

*(Name is a placeholder I picked — say the word and I'll rename the folder and package in one step. Alternatives I liked: `lantern`, `kettle`, `nook`, `parlour`, `sift`.)*

## What it is

A desktop-shaped chat window that talks to a local `llama-server` over the OpenAI-compatible API. It does one thing: conversations with a model on your own GPU. No RAG, no tools, no agents, no provider zoo, no settings labyrinth.

The point isn't to beat Chatbox. It's to be small enough that every line is yours, and to learn the parts that are genuinely interesting: SSE streaming, abort handling, local persistence, markdown rendering under load, and later a native shell.

## Status

**v0.1 — phase 0 done.** Type, stream, stop. No persistence yet (refresh loses the thread) — that's phase 1.

## Run it

Two terminals:

```bash
# 1. the models (router mode: one process, switch models in the app)
cd "/c/AI/Llama Rocm"
./llama-server.exe --models-dir "C:/AI/Models/served" --models-max 1 \
  --port 8088 -c 8192 -ngl 99 --jinja

# 2. the app
cd ~/Documents/Hermes/hearth/app
npm run dev          # http://localhost:5173
```

Backend URL lives in `app/src/lib/config.ts`. The model dropdown is fed by `GET /v1/models`.

`C:/AI/Models/served` is a flat folder of hardlinks to the GGUFs you want exposed — router mode can't see into subfolders. Add a model with:

```bash
ln "/c/AI/Models/<dir>/<model>.gguf" "/c/AI/Models/served/<short-name>.gguf"
```

Switching models unloads the previous one, so the first reply after a switch waits for a full load (~20s for the 14 GB Gemma). That's the router, not a bug.

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
