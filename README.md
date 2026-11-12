# Hearth

A small, local-first chat app. GGUF in, conversation out, nothing else.

## Why this exists

**What it is:** a chat app to call your own — a programmatic expression of will.

**Why:** to spread and democratise AI, and make it easily accessible to all.

**Also:** a showcase. When someone asks what I've built, the answer is my own chat app — not a wrapper around someone else's.

### What that means in practice

A mission that doesn't constrain decisions is decoration. These are the constraints it puts on this project:

- **Accessible means no gatekeeping.** No account, no subscription, no telemetry, no cloud dependency. It runs on your machine, against your models, and works with the network unplugged.
- **"Your own" means it bends.** Themes, profiles, per-conversation prompts, your own backend. A starting point, not a fixed product.
- **A showcase means the code has to be readable.** Small files, one job each, comments that explain *why* rather than *what*. The git history is part of the deliverable — someone should be able to follow the reasoning, not just the result.
- **It stays a personal tool.** Serving thousands of users is a different product with a different trust model. That's a fork, not a feature — see [backlog.md](backlog.md).

*(Name is a placeholder I picked — say the word and I'll rename the folder and package in one step. Alternatives I liked: `lantern`, `kettle`, `nook`, `parlour`, `sift`.)*

## What it is

A desktop-shaped chat window that talks to a local `llama-server` over the OpenAI-compatible API. It does one thing: conversations with a model on your own GPU. No RAG, no tools, no agents, no provider zoo, no settings labyrinth.

The point isn't to beat Chatbox. It's to be small enough that every line is yours, and to learn the parts that are genuinely interesting: SSE streaming, abort handling, local persistence, markdown rendering under load, and later a native shell.

## Status

**v1.1 — phase 3 done.** Markdown, regenerate, edit-and-resend, per-conversation system prompt, five swappable themes (Hearth, Parchment, Slate, Hearth 98 light and dark), `Ctrl+K` palette with message search, Markdown/JSON export, settings and profiles dialogs, and scoped export/restore — whole library or a single chat, chosen in a dialog. Local only: no remote, nothing leaves this machine.

## Run it

Three terminals now — the model server is optional if you start it yourself.

```bash
# 0. optional: let the app start and stop the server itself
cd ~/Documents/Hermes/hearth/app && npm run manager
```

Then:

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

Uploads (avatars, and later attachments) are written by the manager into `data/` at the project root — gitignored, and not part of a JSON backup. Images are resized in the browser before they are sent.

**Themes are files.** Drop a `.json` theme into `data/themes/` and it appears in Settings; use *Export this theme* for a valid starting point. A theme file with a built-in's id replaces it.

**System metrics** are off by default. Settings → System metrics adds a strip to the sidebar: VRAM, live tokens per second, and the machine behind them. Sampling only runs while the strip is visible.

**No engine yet?** Settings → Backend detects your OS and GPU and offers to download a matching build into `data/engine/`. Nothing is downloaded until you press the button, and the checksum is verified before it is unpacked.

With the manager running, **Settings → Backend** gains a context-size field and Start / Stop / Restart buttons. The context is passed as `-c` when the server launches, so changing it restarts the server — llama.cpp sizes the KV cache at load and cannot resize it live. Without the manager, the app uses whatever is already on 8088 and says so.

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

## Resuming work

1. `PLAN.md` — the status line at the top says where things stand
2. `backlog.md` — the triaged list and the proposed order of parts
3. `git log --oneline | head -5` — what changed last

## Running documents

| File | What's in it |
|---|---|
| [PLAN.md](PLAN.md) | Scope, decisions, phases, exit criteria |
| [backlog.md](backlog.md) | Every idea that is not in the current phase |
| [docs/backend.md](docs/backend.md) | The exact HTTP contract we write against, with verified sample responses |
