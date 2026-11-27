# Backend contract

This file documents the **engine** — the `llama-server` Hearth writes against — not Hearth's own manager. The app never talks to the engine directly: it calls the manager's `/api/*`, which proxies, aborts and swaps backends (see `server/index.mjs` for the route table; the manager's routes are grouped one handler per subsystem, and there is no third party to keep in sync).

Everything below was captured live from a `llama-server.exe` ROCm build on 2026-11-11. This is the only upstream API we write against.

## Launch

```bash
cd /path/to/llama.cpp
./llama-server.exe \
  -m "C:/models/gemma-4-E4B-it-Q4_0.gguf" \
  --port 8088 -c 8192 -ngl 99 --jinja
```

`--jinja` enables the model's chat template. `-ngl 99` offloads everything to the GPU.
While the model loads, requests return `503` with `{"error":{"message":"Loading model"}}` — the app should show "starting model…" and retry, not error out.

Hearth's manager expects the backend on **8088** by default; any port works if you point Settings → Backend → Endpoint at it. The manager only proxies to a loopback address unless **Backend on another machine** is switched on, so a backend on a LAN address is refused with a message naming that switch.

## Router mode (model selection)

This build has a router server: one process, many models, loaded on demand.

```bash
cd /path/to/llama.cpp
./llama-server.exe --models-dir "C:/models/served" --models-max 1 \
  --port 8088 -c 8192 -ngl 99 --jinja
```

`GET /props` confirms it: `{"role":"router","max_instances":1,"models_autoload":true}`.

**The directory must be flat.** Pointing `--models-dir` at `C:/models` (which has subfolders) lists the *subfolders* as models — `Gemma`, `Qwen`, `Ornith` — and requesting one fails with `500 model name=Gemma failed to load`. Point it at a folder of `.gguf` files.

`C:/models/served` is that folder, built from hardlinks so nothing is duplicated on disk:

```bash
mkdir -p /c/models/served
ln "/c/models/gemma/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf" "/c/models/served/gemma-4-26b-a4b-it-q4.gguf"
```

`ln` on NTFS makes a hardlink (link count 2, zero extra bytes). Add or remove entries to change what the app can see.

### GET /v1/models (router)

```json
{
  "data": [
    {
      "id": "gemma-4-26b-a4b-it-q4",
      "object": "model",
      "owned_by": "llamacpp",
      "status": {
        "value": "unloaded",
        "args": ["...llama-server.exe", "--host", "127.0.0.1", "--jinja",
                 "--port", "0", "--alias", "gemma-4-26b-a4b-it-q4",
                 "--ctx-size", "8192", "--model", "C:/models/served\\gemma-4-26b-a4b-it-q4.gguf",
                 "--n-gpu-layers", "99"]
      }
    }
  ]
}
```

- `id` is the filename without `.gguf` — clean enough to show directly.
- `status.value` is `loaded` or `unloaded`; useful for a "loading…" hint.
- The child process inherits `-c`, `-ngl`, `--jinja` from the router, so per-model flags are **not** possible in this mode. That's the trade: free model switching, no per-model tuning.
- `--models-max 1` means switching unloads the previous model. First token after a switch waits for a full load (~20s for the 14 GB Gemma). Not a hang.

## GET /v1/models

```json
{
  "object": "list",
  "data": [
    {
      "id": "C:/models/gemma-4-E4B-it-Q4_0.gguf",
      "object": "model",
      "created": 0,
      "owned_by": "llamacpp"
    }
  ]
}
```

The `id` is the full path. Strip to basename for display, send the path back verbatim.

## POST /v1/chat/completions (streaming)

Request:

```json
{
  "messages": [
    { "role": "user", "content": "Say hello in exactly five words." }
  ],
  "stream": true,
  "max_tokens": 60
}
```

Response is standard SSE. Captured verbatim, start to finish:

```
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":"Hello"}}],...}
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"content":" there"}}],...}
...
data: {"choices":[{"finish_reason":"stop","index":0,"delta":{}}],
       "timings":{"cache_n":6,"prompt_n":10,"prompt_ms":78.947,
                  "prompt_per_second":126.667,"predicted_n":16,
                  "predicted_ms":163.16,"predicted_per_second":91.934}}
data: [DONE]
```

Notes that matter for `stream.ts`:

- Deltas arrive in `choices[0].delta.content`. It is **absent** on the final chunk, not empty string — guard with `?? ""`.
- The final chunk repeats `finish_reason: "stop"` and carries `timings`. This is where our tok/s readout comes from.
- `[DONE]` is a bare sentinel line, not JSON. Stop parsing before `JSON.parse`.
- Content is delivered token-ish, so text arrives in fragments ("Hello", " there") — concatenating naively is correct, but do not assume word boundaries.

## Reasoning models stream a different field

`gemma-4-26B-A4B-it` is a reasoning model. Its deltas arrive as `delta.reasoning_content`, and `delta.content` stays `null` until thinking finishes:

```json
{"choices":[{"index":0,"finish_reason":null,"delta":{"role":"assistant","content":null}}]}
{"choices":[{"index":0,"finish_reason":null,"delta":{"reasoning_content":"*"}}]}
{"choices":[{"index":0,"finish_reason":null,"delta":{"reasoning_content":"   Subject"}}]}
```

A client that only reads `delta.content` shows nothing at all — the app looks frozen while the model is thinking. `stream.ts` now handles both and renders thinking in a collapsed block.

With `max_tokens: 80` this model spent the entire budget thinking and never emitted an answer. Budget accordingly, or the reply looks empty.

## POST /v1/chat/completions (non-streaming)

Same body with `"stream": false`. Chosen keys from the verified response:

```json
{
  "choices": [{ "index": 0, "finish_reason": "stop",
                "message": { "role": "assistant", "content": "..." } }],
  "usage": { "prompt_tokens": 16, "completion_tokens": 16, "total_tokens": 32,
             "prompt_tokens_details": { "cached_tokens": 6 } },
  "timings": { "prompt_per_second": 126.667, "predicted_per_second": 91.934,
               "cache_n": 6, "prompt_n": 10, "predicted_n": 16 }
}
```

## Measured throughput (Gemma-4-E4B Q6_K_P, 8k ctx)

| | tok/s |
|---|---|
| Prompt processing | ~127 (cold), cache hits skip this |
| Generation | **~92** |

A larger model at a lower quantisation runs an order of magnitude slower, which is why the small build is the iteration loop and a big one is the "does it hold up on a real model" test.
