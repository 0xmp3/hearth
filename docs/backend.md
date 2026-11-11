# Backend contract

Everything below was captured live from `llama-server.exe` (ROCm build, `C:\AI\Llama Rocm`) on this machine on 2026-11-11. This is the only API we write against.

## Launch

```bash
cd "/c/AI/Llama Rocm"
./llama-server.exe \
  -m "C:/AI/Models/Gemma/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf" \
  --port 8088 -c 8192 -ngl 99 --jinja
```

`--jinja` enables the model's chat template. `-ngl 99` offloads everything to the GPU.
While the model loads, requests return `503` with `{"error":{"message":"Loading model"}}` — the app should show "starting model…" and retry, not error out.

Ports in use on this box: **8080 = Strata**, **8088 = our llama-server**.

## GET /v1/models

```json
{
  "object": "list",
  "data": [
    {
      "id": "C:/AI/Models/Gemma/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf",
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

For comparison, Strata on DeepSeek V4.1 Flash IQ2_XXS runs ~10 tok/s — so the Gemma build is our iteration loop and DeepSeek is the "does it hold up on a real model" test.

## Unverified / to check in phase 0

1. `curl 127.0.0.1:8080/v1/models` with Strata running — does it expose the OpenAI API or only its own pack protocol over the control socket in `AppData\Local\Strata\runtime\launch-*.json`?
2. Whether this llama.cpp build loads `deepseek41` arch (`C:/AI/Models/Deepseek-V4.1-Flash/IQ2_XXS/...00001-of-00006.gguf`).
3. Whether `/v1/models` can list more than the one loaded model (llama-server is one-model-per-process by default, so probably not — the picker may become a launcher rather than a dropdown).
