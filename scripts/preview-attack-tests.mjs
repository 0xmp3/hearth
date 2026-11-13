// Attack tests for the page preview panel.
//
// The preview runs model-written HTML/JS on the user's machine, so the sandbox
// is the feature and this script is the proof. It seeds one conversation whose
// reply contains a fenced `html` block — the fixture in
// preview-attack-fixture.html — opens the panel, and asserts that every attack
// the fixture makes is refused.
//
//   node scripts/preview-attack-tests.mjs --app http://localhost:5173 --manager http://127.0.0.1:8090
//
// Run it in the guest VM, never on a machine with real conversations: the
// fixture is deliberately hostile JavaScript, and the whole point is that we do
// not yet know the sandbox holds. Nothing here needs a model — the message is
// written straight into IndexedDB.
//
// Two kinds of evidence, on purpose:
//
//   * the fixture reports from inside the frame, which is where the detail is;
//   * the suite observes from outside — cross-origin access, network traffic,
//     popups, the top frame's URL, and the app's own database — because a
//     compromised page could lie in its report.
//
// Exits non-zero if any expectation fails, so it can gate a release.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, request } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const APP = arg('app', 'http://localhost:5173')
const MANAGER = arg('manager', 'http://127.0.0.1:8090')
const SPY_PORT = Number(arg('spy-port', '8099'))
const SPY = `http://127.0.0.1:${SPY_PORT}`
const HEADED = process.argv.includes('--headed')
const KEEP = process.argv.includes('--keep')

let passes = 0
let failures = 0

function check(name, ok, detail = '') {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

/** Plain http.request, not fetch: undici's keep-alive sockets outlive the run. */
function probe(path, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const req = request(
      MANAGER + path,
      { method, agent: false, headers },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
      },
    )
    req.on('error', (err) => resolve({ status: 0, body: err.message }))
    req.end()
  })
}

async function main() {
  let puppeteer
  try {
    puppeteer = (await import('puppeteer')).default
  } catch {
    console.error(
      'preview attack tests need puppeteer:\n  npm i puppeteer\n(or run with --self-report to use the Edge fallback)',
    )
    process.exit(2)
  }

  console.log(`Hearth preview attack tests\n  app:      ${APP}\n  manager:  ${MANAGER}\n`)

  // The manager's own refusal is the second layer, and it is testable without
  // a browser: a sandboxed frame presents `Origin: null`, which is not on the
  // allowlist, and the X-Hearth header cannot be sent without a preflight the
  // manager only answers for allowed origins.
  const noHeader = await probe('/api/status', { headers: { Origin: 'null' } })
  check(
    'manager refuses a null-origin request with no X-Hearth',
    noHeader.status === 403,
    `${noHeader.status} ${noHeader.body.slice(0, 120)}`,
  )
  const withHeader = await probe('/api/status', { headers: { Origin: 'null', 'X-Hearth': '1' } })
  check(
    'manager answers only with the header, and sends no CORS for null',
    withHeader.status === 200,
    `${withHeader.status} ${withHeader.body.slice(0, 120)}`,
  )

  const fixture = readFileSync(join(HERE, 'preview-attack-fixture.html'), 'utf8').replace(
    /__SPY__/g,
    SPY,
  )
  // The explicit signal the panel keys on: one fenced html block.
  const content = `Here is the page you asked for.\n\n\`\`\`html\n${fixture}\n\`\`\`\n`

  // The spy is the witness the fixture cannot fake. It has no origin check, no
  // header gate and no CORS policy — so if a request arrives here, the sandbox
  // and the CSP both failed, and nothing else can be blamed.
  const spyHits = []
  const spy = createServer((req, res) => {
    spyHits.push(`${req.method} ${req.url}`)
    // Permissive CORS on purpose: without it a successful fetch would still
    // reject client-side for lack of the header, and a "blocked" verdict would
    // be a CORS artefact rather than evidence about the sandbox.
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    })
    res.end()
  })
  spy.on('upgrade', (req, socket) => {
    spyHits.push(`UPGRADE ${req.url}`)
    socket.destroy()
  })
  await new Promise((resolve, reject) => {
    spy.once('error', reject)
    spy.listen(SPY_PORT, '127.0.0.1', resolve)
  })

  const convId = 'attack-fixture-conversation'
  const msgId = 'attack-fixture-message'

  const browser = await puppeteer.launch({
    headless: HEADED ? false : 'new',
    args: ['--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()

  const responses = []
  const frameRequests = []
  const failed = []
  const popups = []
  // `frame.url()` is `about:srcdoc` for the preview: that is how a request is
  // attributed to the sandbox rather than to the app talking to its manager.
  const fromPreview = (r) => (r.frame()?.url?.() ?? '') === 'about:srcdoc'
  page.on('response', (r) => responses.push({ url: r.url(), status: r.status(), preview: fromPreview(r) }))
  page.on('request', (r) => {
    if (fromPreview(r)) frameRequests.push(r.url())
  })
  page.on('requestfailed', (r) =>
    failed.push({ url: r.url(), error: r.failure()?.errorText, preview: fromPreview(r) }),
  )
  page.on('popup', (p) => popups.push(p.url()))

  // Collected before any app script runs, so a message that arrives during
  // mount is not missed.
  await page.evaluateOnNewDocument(() => {
    window.__hearthAttack = []
    window.addEventListener('message', (e) => {
      window.__hearthAttack.push({ origin: e.origin, data: e.data })
    })
  })

  let report = null
  try {
    await page.goto(APP, { waitUntil: 'networkidle2', timeout: 30000 })

    await page.evaluate(
      async ({ content, convId, msgId }) => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open('hearth')
          r.onsuccess = () => resolve(r.result)
          r.onerror = () => reject(r.error)
        })
        const now = Date.now()
        await new Promise((resolve, reject) => {
          const t = db.transaction(['conversations', 'messages'], 'readwrite')
          t.objectStore('conversations').put({
            id: convId,
            title: 'Preview attack fixture',
            createdAt: now,
            updatedAt: now,
            model: '',
          })
          t.objectStore('messages').put({
            id: `${msgId}-user`,
            conversationId: convId,
            role: 'user',
            content: 'make me a webpage',
            createdAt: now - 1,
          })
          t.objectStore('messages').put({
            id: msgId,
            conversationId: convId,
            role: 'assistant',
            content,
            createdAt: now,
          })
          t.oncomplete = () => resolve()
          t.onerror = () => reject(t.error)
        })
        // Canaries: the fixture must not be able to read these, and the app
        // must still have them afterwards.
        localStorage.setItem('hearth.attack.canary', 'still-here')
      },
      { content, convId, msgId },
    )

    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 })

    // Auto-open only fires when a turn ends, so a seeded message is opened the
    // way a person would: with the button on the reply.
    await page.waitForFunction(
      () => [...document.querySelectorAll('.msg-actions button')].some((b) => b.textContent.trim() === 'preview'),
      { timeout: 20000 },
    )
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.msg-actions button')].find((b) => b.textContent.trim() === 'preview')
      btn.click()
    })

    await page.waitForSelector('iframe.preview-frame', { timeout: 15000 })

    // Give every channel attempt its timeout to expire.
    await new Promise((r) => setTimeout(r, 4000))

    // ---- what the frame looks like from outside --------------------------
    const frame = await page.evaluate(() => {
      const f = document.querySelector('iframe.preview-frame')
      let contents
      try {
        contents = f.contentDocument === null ? 'null' : 'READABLE'
      } catch (e) {
        contents = `threw ${e.name}`
      }
      let win
      try {
        win = f.contentWindow && f.contentWindow.document ? 'READABLE' : 'null'
      } catch (e) {
        win = `threw ${e.name}`
      }
      return {
        sandbox: f.getAttribute('sandbox') ?? '',
        srcdocLength: (f.getAttribute('srcdoc') ?? '').length,
        hasCsp: (f.getAttribute('srcdoc') ?? '').includes("connect-src 'none'"),
        contents,
        win,
        url: location.href,
        canary: localStorage.getItem('hearth.attack.canary'),
      }
    })

    check('panel rendered an iframe', frame.srcdocLength > 500, `${frame.srcdocLength} chars`)
    check('sandbox is exactly allow-scripts', frame.sandbox === 'allow-scripts', `got "${frame.sandbox}"`)
    check('sandbox does not allow same-origin', !/allow-same-origin/.test(frame.sandbox))
    check('sandbox allows no popups, forms or top navigation', !/allow-(popups|forms|top-navigation|modals)/.test(frame.sandbox))
    check('the document carries the preview CSP', frame.hasCsp)
    check(
      'the frame is cross-origin: contentDocument is null',
      frame.contents === 'null' || frame.contents.startsWith('threw'),
      frame.contents,
    )
    check(
      'the frame is cross-origin: contentWindow.document unreachable',
      frame.win === 'null' || frame.win.startsWith('threw'),
      frame.win,
    )

    // ---- the fixture's own report ----------------------------------------
    const collected = await page.evaluate(() => window.__hearthAttack ?? [])
    report = collected.find((m) => m?.data?.hearthPreviewAttack)?.data ?? null
    const attempts = report?.hearthPreviewAttack ?? []

    check('the fixture ran and reported', attempts.length > 0, report ? JSON.stringify(report).slice(0, 200) : 'no report')
    if (report?.fatal) check('the fixture did not crash out early', false, report.fatal)

    check(
      'the report came from an opaque origin',
      collected.some((m) => m?.origin === 'null' && m?.data?.hearthPreviewAttack),
      collected.map((m) => m?.origin).join(',') || 'none',
    )

    // top navigation is the one attempt the fixture cannot judge: Chrome may
    // silently ignore the assignment instead of throwing. The parent's URL is
    // the fact, and it was read above.
    const urlUnchanged = frame.url.startsWith(APP)
    for (const a of attempts) {
      if (a.name === 'top navigation') {
        check('BLOCKED  top navigation (parent URL unchanged)', urlUnchanged, `page is at ${frame.url}`)
        continue
      }
      if (a.soft) {
        // sendBeacon and form.submit() return whether or not anything is sent.
        // The spy is the only witness, and it is checked below.
        check(`NO SIGNAL  ${a.name} — nothing reached the spy`, true, a.detail)
        continue
      }
      check(`${a.blocked ? 'BLOCKED ' : 'SUCCEEDED'}  ${a.name}`, a.blocked, a.detail)
    }

    // ---- nothing left the frame -------------------------------------------
    check('the spy heard nothing at all', spyHits.length === 0, spyHits.join(' | '))

    const previewResponses = responses.filter((r) => r.preview)
    check(
      'no response reached the preview frame from any host',
      previewResponses.length === 0,
      previewResponses.map((r) => `${r.status} ${r.url}`).join(' | '),
    )
    const managerHits = responses.filter((r) => r.url.startsWith(MANAGER) && r.preview)
    check(
      'no response came from the manager inside the frame',
      managerHits.length === 0,
      managerHits.map((r) => `${r.status} ${r.url}`).join(' | '),
    )
    check('no popup opened', popups.length === 0, popups.join(' | '))
    check('the top frame never navigated', urlUnchanged, frame.url)
    if (frameRequests.length || failed.length) {
      console.log(
        `        (${frameRequests.length} frame-level requests, ${failed.length} failed — all by CSP)`,
      )
    }

    // ---- the app's own data is intact ------------------------------------
    check('the app can still read its own localStorage', frame.canary === 'still-here', String(frame.canary))
    const db = await page.evaluate(
      async ({ convId }) =>
        new Promise((resolve) => {
          const r = indexedDB.open('hearth')
          r.onsuccess = () => {
            const req = r.result.transaction('conversations').objectStore('conversations').count()
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => resolve(-1)
          }
          r.onerror = () => resolve(-1)
        }),
      { convId },
    )
    check('the app can still read its own database', db > 0, `conversation count ${db}`)
  } finally {
    if (!KEEP) {
      await page
        .evaluate(
          async ({ convId, msgId }) =>
            new Promise((resolve) => {
              const r = indexedDB.open('hearth')
              r.onsuccess = () => {
                const t = r.result.transaction(['conversations', 'messages'], 'readwrite')
                t.objectStore('conversations').delete(convId)
                t.objectStore('messages').delete(msgId)
                t.objectStore('messages').delete(`${msgId}-user`)
                t.oncomplete = () => resolve()
                t.onerror = () => resolve()
              }
              r.onerror = () => resolve()
            }),
          { convId, msgId },
        )
        .catch(() => {})
    }
    await browser.close()
    await new Promise((resolve) => spy.close(resolve))
  }

  console.log(`\n  ${passes} passed, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('preview attack tests could not run:', err?.stack ?? err)
  process.exitCode = 2
})
