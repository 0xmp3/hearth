// Install app/ with the npm that ships inside this Node.
//
// Why this is a script and not `"postinstall": "npm --prefix app install"`:
//
//   Found by a clean-machine first-run on Node 22 / npm 10.9.9. The nested npm
//   lost its PATH inside the lifecycle script — `'npm' is not recognized as an
//   internal or external command` — and npm retried into itself, one log file a
//   second, until it died with a wall of `npm error npm error …`. A stranger
//   cannot read that, and it buries the real problem, which is the Node version.
//
//   Two consequences drove this file:
//     1. **Resolve npm from `process.execPath`, never from PATH.** npm's CLI sits
//        next to the Node binary that is running us, and that path is knowable.
//     2. **Check the Node version first.** A wrong Node should fail with one
//        sentence, not after npm has half-installed things.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'app')

const major = Number(process.versions.node.split('.')[0])
if (major < 24) {
  console.error(
    `Hearth needs Node 24 or newer (the library is stored with node:sqlite).\n` +
      `You are on Node ${process.versions.node}. Install Node 24 or later, remove node_modules, then run npm install again.`,
  )
  process.exit(1)
}

// Where npm's CLI lives, relative to the running Node. Windows installs it under
// node_modules\npm next to node.exe; Unix builds usually keep it one level up in
// lib/node_modules. Both are checked rather than assumed.
const candidates = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
]
const cli = candidates.find((path) => existsSync(path))
if (!cli) {
  console.error(
    `could not find npm next to Node (${dirname(process.execPath)}).\n` +
      `Run \`npm install\` inside app/ yourself, or reinstall Node from nodejs.org.`,
  )
  process.exit(1)
}

// cwd, not --prefix: npm should install where it is standing, and the app's own
// package.json decides what that means.
const child = spawn(process.execPath, [cli, 'install', '--no-audit', '--no-fund'], {
  cwd: APP,
  stdio: 'inherit',
})

child.on('error', (err) => {
  console.error(`could not run npm: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 0)
})
