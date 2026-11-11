// Phase 0: one hardcoded backend. Phase 2 turns this into a picker.
export const BASE_URL = 'http://127.0.0.1:8088'
export const SYSTEM_PROMPT = ''

// Reasoning models spend tokens thinking before they answer. 1024 was enough
// to let one think itself to a standstill and return nothing at all.
export const MAX_TOKENS = 2048
