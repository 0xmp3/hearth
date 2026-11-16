# Working on Hearth

Notes for whoever picks this up next — a person, or an agent driving one. The
[README](README.md) is for users; this is for people changing the code.

## Run it

```bash
npm install          # installs app/ too (the root has no dependencies of its own)
npm start            # manager on 8090, app on 5173 — Ctrl+C stops both
```

Node **24+** (the library is stored with `node:sqlite`). Windows 10/11.

`npm start` reuses anything already listening instead of spawning a duplicate, and
on Ctrl+C it asks the manager to stop first (`/api/stop`) so `llama-server` is
never orphaned. That matters on a machine where another app also runs llama.cpp.

## The gate

```bash
npm run check        # typecheck → build → theme check → tests
```

It is the same four commands CI runs. A change is not done until this is green —
not "the diff looks right". `npm test` alone is the fast loop (~0.4 s).

- **typecheck** runs two configs: `app/tsconfig.json` (browser only, `types:
  ["vite/client"]`, tests excluded) and `app/tsconfig.test.json` (adds `node` and
  `allowJs`, so tests can import the manager's `.mjs`). A `node:` import in
  browser code must still fail, which is why they are separate.
- **check:theme** fails on a raw hex or a spacing px in `styles.css` — themes are
  variables, so the contract is enforced rather than described.
- **tests** are vitest over the pure modules only: no server, no model, no
  browser, no `data/`. `scripts/guard-tests.mjs` and
  `scripts/preview-attack-tests.mjs` are separate acceptance suites — they need a
  live manager, real browser, and (for the preview one) a VM, because the fixture
  is deliberately hostile.

## Layout

| Path | What lives there |
|---|---|
| `app/src/lib/` | Everything that can be pure: streaming, history assembly, memory, vectors, tools, preview, themes |
| `app/src/components/` | React, one file per surface |
| `app/src/hooks/useHearth.ts` | All the state and the turn loop |
| `server/index.mjs` | The manager: routes, engine lifecycle, uploads |
| `server/<area>/` | One folder per subsystem — engine, models, embed, rerank, tts, net, workspace, searxng, metrics, db |
| `data/` | **The user's.** Library, models, voices, uploads, config. Gitignored. |
| `scripts/` | Start, install, theme check, and the two acceptance suites |

`server/` has no `package.json` and imports only `node:` builtins — no supply
chain on the component that spawns processes. Keep it that way.

## Conventions that are load-bearing

- **The app never calls a backend directly.** `lib/stream.ts`, `title.ts`,
  `memory.ts` and `compaction.ts` all POST to the manager's `/api/chat`, which
  proxies and aborts upstream when the client leaves. Most local engines send no
  CORS headers, so a direct call is silently discarded.
- **Downloads verify a digest and refuse on mismatch.** `server/net/download.mjs`
  streams over HTTP/1.1 and hashes as it goes; callers pin a sha256 (from the
  release asset, Hugging Face's LFS oid, or a published checksum). An unverified
  file is refused, not warned about — it is executed or loaded afterwards.
- **Do not use `fetch` for large downloads.** undici negotiates HTTP/2 and leaves
  the flow-control window at 64 KB; measured 1.26 MB/s against 24.6 MB/s over
  HTTP/1.1 on the same file. A 4 MB buffer changes nothing.
- **`X-Hearth: 1` plus an exact-origin allow-list is the CSRF guard.** Routes added
  outside it must be safe from a stray `<img>` on any page — `/api/file/` is
  exempt on purpose, and every line of its handler is inside a `try`.
- **Three gates on tools**: the global permission, the conversation's mode (which
  can only narrow), and the manager's workspace/network switches underneath. A
  tool that is off is never declared — a tool that exists and fails teaches the
  model to promise it.
- **Comments explain why.** The code says what it does; the comments say what
  broke, what was measured, or which obvious alternative was rejected. Several
  read like post-mortems because they are.
- **Errors name the cause.** "needs Node 24 or newer … you are on 22.23.5" beats a
  stack trace through `node:sqlite`.

## Traps that have cost real hours

- **`data/` is the user's library.** Never seed, migrate or test against it — the
  one-time migration flag in `hearth.db` means a test can silently strand their
  history. Point a manager at a scratch copy.
- **Never kill `llama-server` by name.** Other local apps run llama.cpp too. Stop
  it through the manager's `/api/stop` or by port owner.
- **`vite` binds `::1`, not `127.0.0.1`.** `curl localhost:5173` answers;
  `curl 127.0.0.1:5173` does not, and looks like the dev server is down.
- **`config.json`'s `enginePath` is the binary, not its folder.** A directory
  resolves as "exists" and fails at `spawn` with a bare ENOENT.
- **A preview page can navigate itself.** No CSP directive stops it; the panel
  detects the second `load` and replaces the frame. Do not "fix" it by assuming a
  directive exists.
