#!/usr/bin/env node
// The theme contract, enforced.
//
// Colour comes from theme/types.ts. Spacing comes from theme/tokens.css. This
// script fails when a component breaks either rule, because a contract nobody
// checks is a comment: the app had 380 raw px values before the scale existed,
// and nothing stopped the next one.
//
// Run with: npm run check:theme

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'app', 'src')

// Theme files are where the values are allowed to be literal.
const EXEMPT = /[\\/]theme[\\/]/

const SPACING = new Set([
  'padding',
  'margin',
  'gap',
  'row-gap',
  'column-gap',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
])

const HEX = /#[0-9a-fA-F]{3,8}\b/g
const DECL = /([a-z-]+)\s*:\s*([^;{}]+);/g
const PX = /(-?\d+(?:\.\d+)?)px/g

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(css|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const problems = []

for (const file of walk(SRC)) {
  if (EXEMPT.test(file)) continue
  const rel = relative(SRC, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')

  // A line may opt out with `theme-contract:ignore`, and a region with
  // ignore-start / ignore-end. Both are for values that are deliberately
  // literal — a generated colour, or the pre-JS fallback block.
  let ignoring = false

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`

    if (line.includes('theme-contract:ignore-start')) ignoring = true
    if (line.includes('theme-contract:ignore-end')) {
      ignoring = false
      return
    }
    if (ignoring || line.includes('theme-contract:ignore')) return

    // A colour literal is always a violation: it cannot follow a theme.
    for (const m of line.matchAll(HEX)) {
      problems.push(`${at}  colour ${m[0]} — use a theme token`)
    }

    // Spacing must come from the scale. 1px is a hairline, not a gap.
    if (file.endsWith('.css')) {
      for (const decl of line.matchAll(DECL)) {
        const [, prop, value] = decl
        if (!SPACING.has(prop)) continue
        for (const px of value.matchAll(PX)) {
          if (Number(px[1]) === 1) continue
          problems.push(`${at}  ${prop}: ${px[0]} — use var(--space-N)`)
        }
      }
    }
  })
}

if (problems.length) {
  console.error(`theme contract: ${problems.length} violation(s)\n`)
  for (const p of problems) console.error('  ' + p)
  console.error('\nColour lives in theme/types.ts, spacing in theme/tokens.css.')
  process.exit(1)
}

console.log('theme contract: clean')
