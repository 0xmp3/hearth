// Tests for the pure modules, and nothing else.
//
// Deliberately node, not jsdom: everything under test here is string building,
// scoring and validation, so the suite needs no DOM, no manager, no model and no
// data directory — which is what keeps it under a second and safe to run
// anywhere, including CI.
//
// The browser-side suites stay where they were: `scripts/guard-tests.mjs` and
// `scripts/preview-attack-tests.mjs` need a live manager and a real browser, and
// the second one is deliberately hostile, so it runs in the test VM.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // A test that writes anything must use its own temp dir; this is the user's
    // machine and `data/` is their real library.
    restoreMocks: true,
  },
})
