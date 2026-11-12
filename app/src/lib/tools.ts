// The tools the model can call.
//
// One tool, on purpose. The point of this pass is to prove the loop end to end
// — request with tools, accumulate the streamed call, execute, feed the result
// back, answer. Adding a second tool after that is a copy of this file, not a
// new subsystem.

import * as db from './db'
import type { ToolDef } from './stream'

/** What the UI shows for a tool that ran. */
export type ToolRecord = {
  name: string
  ok: boolean
  summary: string
}

export type ToolOutcome = {
  /** Fed back to the model as the tool result. */
  text: string
  record: ToolRecord
}

export const TOOLS: ToolDef[] = [
  {
    name: 'remember',
    description:
      'Save a durable fact about the user so it persists across conversations. ' +
      'Use it when the user states something about themselves that will still be true later: ' +
      'preferences, ongoing projects, hardware, tools, constraints, or how they want you to reply. ' +
      'Do not use it for greetings, one-off questions, or anything about yourself.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'One short sentence in the third person, e.g. "Uses Linux" or "Prefers short answers".',
        },
        scope: {
          type: 'string',
          enum: ['global', 'conversation'],
          description:
            'global = true in every conversation. conversation = only true in this one.',
        },
      },
      required: ['text', 'scope'],
      additionalProperties: false,
    },
  },
]

const KNOWN = new Set(TOOLS.map((t) => t.name))

/**
 * Appended to the system prompt when tools are on.
 *
 * The tool's own description is not enough: a model with an empty system prompt
 * reads the schema and ignores it. This is the sentence that turns a declared
 * capability into a used one.
 */
export const TOOL_GUIDANCE = `You have a tool called remember. Call it whenever the user tells you something durable about themselves — a preference, an ongoing project, hardware or software they use, a constraint, or how they want you to reply. Do not call it for greetings, one-off questions, or anything about yourself. Calling it is silent: the user sees a small note, so do not announce that you are saving something.`

function sameText(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Run a tool call. Never throws: a failing tool becomes a result the model can
 * read, because a thrown error here would end the whole turn.
 */
export async function runTool(
  name: string,
  rawArgs: unknown,
  conversationId: string,
): Promise<ToolOutcome> {
  if (!KNOWN.has(name)) {
    return {
      text: `Unknown tool "${name}".`,
      record: { name, ok: false, summary: `unknown tool` },
    }
  }

  const args = (rawArgs ?? {}) as Record<string, unknown>
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  const scope = args.scope === 'conversation' ? 'conversation' : 'global'

  if (!text) {
    return {
      text: 'Nothing was saved: "text" was empty.',
      record: { name, ok: false, summary: 'empty' },
    }
  }

  // Dedupe in the app, not in the model: it cannot see the whole store, and a
  // repeated fact is worse than a missing one — it biases every later reply.
  const existing = await db.listMemories()
  if (existing.some((m) => sameText(m.text, text))) {
    return {
      text: `Already known: ${text}`,
      record: { name, ok: true, summary: 'already known' },
    }
  }

  const now = Date.now()
  await db.putMemory({
    id: db.newId(),
    text,
    scope,
    ownerId: scope === 'conversation' ? conversationId : undefined,
    createdAt: now,
    updatedAt: now,
    sourceConversationId: conversationId,
  })

  return {
    text: `Saved: ${text}`,
    record: { name, ok: true, summary: text },
  }
}
