// All the state. Components render; this decides.
// The turn driver is injected, so swapping chat for an agent is a one-line change.

import { useEffect, useRef, useState } from 'react'
import * as db from '../lib/db'
import { listModels, type ModelInfo } from '../lib/models'
import { agentTurn, type TurnDriver } from '../lib/turn'
import { NO_TOOLS, runTool as executeTool, toolGuidance, type ToolPolicy } from '../lib/tools'
import { BASE_URL, SYSTEM_PROMPT } from '../lib/config'
import { suggestTitle } from '../lib/title'
import type { ChatMessage, ContentPart, Stats } from '../lib/stream'
import { toDataUrl, type Attachment } from '../lib/attachments'
import {
  CAPTURE_EVERY,
  applyExtraction,
  buildMemoryBlock,
  extractMemories,
} from '../lib/memory'
import {
  buildSummaryBlock,
  compactConversation,
  currentSummary,
  factsOf,
  historyAfter,
  shouldCompact,
} from '../lib/compaction'

export type HearthOptions = {
  /** Reply budget, in tokens. */
  maxTokens?: number
  resolveProfile?: (profileId: string | null | undefined) => db.Profile | null
  /**
   * Which tool families a conversation may use. A function, not a value: the
   * policy depends on the conversation, and the hook is the only place that
   * knows which one a turn belongs to.
   */
  tools?: (conv: db.Conversation) => ToolPolicy
}

export function useHearth(
  turn: TurnDriver = agentTurn,
  resolveCharacter?: (characterId: string | null | undefined) => db.Character | null,
  options: HearthOptions = {},
) {
  const { maxTokens = 2048, resolveProfile, tools: policyFor } = options
  const policyForConv = (conv: db.Conversation): ToolPolicy => policyFor?.(conv) ?? NO_TOOLS
  const [conversations, setConversations] = useState<db.Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<db.Message[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])

  // A conversation remembers the model it was using. If the backend no longer
  // serves it — you switched from Strata back to llama.cpp — fall back to the
  // first model instead of sending an id the server will reject.
  const resolveModel = (id?: string | null) =>
    id && models.some((m) => m.id === id) ? id : models[0]?.id ?? ''
  const [model, setModel] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [memories, setMemories] = useState<db.Memory[]>([])
  const [capturing, setCapturing] = useState(false)
  const [condensing, setCondensing] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const draftRef = useRef<db.Message | null>(null)
  const saveTimer = useRef<number | null>(null)

  // ---- persistence of the in-flight reply -------------------------------
  // Debounced so a long reply doesn't hammer IndexedDB, but frequent enough
  // that closing the tab mid-stream still leaves the partial text behind.
  function scheduleSave() {
    if (saveTimer.current !== null) return
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      if (draftRef.current) void db.putMessage({ ...draftRef.current })
    }, 400)
  }

  function flushSave() {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    if (draftRef.current) void db.putMessage({ ...draftRef.current })
  }

  // ---- boot -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // History first, and independently of the backend. A model server that is
      // not running must not hide the conversations that are already on disk —
      // that is the difference between "the engine is off" and "my chats are
      // gone", and only one of those is true.
      try {
        const [convs, mems] = await Promise.all([db.listConversations(), db.listMemories()])
        if (cancelled) return
        setConversations(convs)
        setMemories(mems)
        if (convs[0]) {
          setActiveId(convs[0].id)
          setMessages(await db.listMessages(convs[0].id))
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }

      try {
        const list = await listModels(BASE_URL)
        if (cancelled) return
        setModels(list)
        setModel((current) => resolveModel(current) || list[0]?.id || '')
      } catch {
        // No backend: the app still opens, reads and exports. Sending will say
        // why it cannot.
        if (!cancelled) setModels([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ---- helpers ----------------------------------------------------------
  // A message with attachments becomes content parts: text files are inlined
  // into the prompt, images are read back into data URLs. Everything else is
  // the plain string it always was.
  async function toChatMessage(m: db.Message): Promise<ChatMessage> {
    const atts = m.attachments ?? []
    if (!atts.length) return { role: m.role, content: m.content }

    let text = m.content
    for (const a of atts) {
      if (a.kind === 'text' && a.text) {
        const note = a.truncated ? ' (truncated)' : ''
        text += `\n\n<file name="${a.name}"${note}>\n${a.text}\n</file>`
      }
    }

    const images = atts.filter((a) => a.kind === 'image' && a.url)
    if (!images.length) return { role: m.role, content: text }

    const parts: ContentPart[] = [{ type: 'text', text }]
    for (const a of images) {
      parts.push({ type: 'image_url', image_url: { url: await toDataUrl(a.url!) } })
    }
    return { role: m.role, content: parts }
  }

  async function buildHistory(msgs: db.Message[], conv: db.Conversation): Promise<ChatMessage[]> {
    // Character first (who you are), then the conversation's own prompt (what
    // this chat is about). Either can be empty.
    const character = resolveCharacter?.(conv.characterId)?.systemPrompt?.trim()
    // Who you are, who the model is, what is known about the user, what this chat is about.
    const profile = resolveProfile?.(conv.profileId)?.description?.trim()
    // Read fresh rather than from state: a fact or a summary written by the
    // background passes after the last render must be in this request.
    const stored = await db.listMemories()
    const summary = currentSummary(stored, conv.id)
    const memory = buildMemoryBlock(stored, conv.id, conv.characterId ?? null)
    // Tools are on for every turn, so the guidance is always relevant.
    const system = [
      profile,
      character,
      buildSummaryBlock(summary),
      memory,
      toolGuidance(policyForConv(conv)),
      conv.systemPrompt?.trim() || SYSTEM_PROMPT,
    ]
      .filter(Boolean)
      .join('\n\n')
    // The oldest turns are represented by the summary, not sent again.
    const live = historyAfter(msgs, summary)
    return [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      // An assistant turn that produced no text (thinking ate the budget, or
      // the user stopped it before the first token) is noise to the model and
      // makes it reason about "the empty response" instead of the question.
      ...(await Promise.all(
        live
          .filter((m) => m.content.trim().length > 0 || (m.attachments?.length ?? 0) > 0)
          .map(toChatMessage),
      )),
    ]
  }

  // A reply streams for a while and the conversation can change underneath it
  // (prompt, profile, character, model). `touch` used the snapshot captured when
  // the turn started, so finishing a reply silently reverted an edit made during
  // it — the profile override written mid-stream was gone after the reply landed.
  // Every write reads the freshest copy from here instead.
  // llama-server has one slot by default, and two background model calls issued
  // at once collide ("failed to find a memory slot"): the reply lands and both
  // the extraction pass and the compaction pass fire. Serialise them. It also
  // keeps the two writers to the memory store from interleaving.
  const bgRef = useRef<Promise<unknown>>(Promise.resolve())
  function inBackground(task: () => Promise<unknown>): Promise<unknown> {
    bgRef.current = bgRef.current.then(task, task)
    return bgRef.current
  }

  const convsRef = useRef<db.Conversation[]>([])
  useEffect(() => {
    convsRef.current = conversations
  }, [conversations])

  function touch(conv: db.Conversation) {
    const latest = convsRef.current.find((c) => c.id === conv.id) ?? conv
    const updated = { ...latest, updatedAt: Date.now() }
    void db.putConversation(updated)
    setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
  }

  // One place where a turn is run. send / regenerate / edit all funnel here.
  async function runTurn(conv: db.Conversation, history: ChatMessage[], assistantMsg: db.Message) {
    const controller = new AbortController()
    abortRef.current = controller
    draftRef.current = assistantMsg
    setStreaming(true)

    try {
      const activeModel = resolveModel(conv.model) || model

      // The conversation follows the backend. If the model it remembered is not
      // served any more, record the one actually used, so the next turn does not
      // have to resolve it again and the record stops lying.
      if (conv.model !== activeModel) {
        const updated = { ...conv, model: activeModel, updatedAt: Date.now() }
        convsRef.current = convsRef.current.map((c) => (c.id === conv.id ? updated : c))
        void db.putConversation(updated)
        setConversations((prev) => prev.map((c) => (c.id === conv.id ? updated : c)))
      }
      await turn({
        model: activeModel,
        messages: history,
        // Sent as asked. `--ctx-size` is what the server allocated, not what the
        // model can do, and llama.cpp stops at its own limit anyway. Clamping
        // here would silently override the user's choice.
        maxTokens,
        signal: controller.signal,
        append: (field, text) => {
          const draft = draftRef.current
          if (!draft) return
          draft[field] = (draft[field] ?? '') + text
          const snapshot = { ...draft }
          setMessages((prev) => prev.map((m) => (m.id === snapshot.id ? snapshot : m)))
          scheduleSave()
        },
        onStats: (s) => {
          setStats((prev) => ({ ...prev, ...s }))
          if (draftRef.current) {
            draftRef.current.stats = {
              ...(draftRef.current.stats ?? {}),
              ...s,
              model: activeModel,
            }
          }
        },
        // Tools run in the app, not the model: this is the only place a reply
        // can change anything outside itself.
        runTool: (name, args) => executeTool(name, args, conv.id, policyForConv(conv)),
        // The driver builds the tool list from this, so a family that is off
        // never reaches the request at all.
        tools: policyForConv(conv),
        onTool: (record) => {
          const draft = draftRef.current
          if (!draft) return
          draft.tools = [...(draft.tools ?? []), record]
          const snapshot = { ...draft }
          setMessages((prev) => prev.map((m) => (m.id === snapshot.id ? snapshot : m)))
          // A saved memory should show up in the panel without a reload.
          if (record.ok && record.name === 'remember') void db.listMemories().then(setMemories)
        },
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Not a failure: keep what we have and mark it partial.
        if (draftRef.current) draftRef.current.aborted = true
      } else {
        setError((err as Error).message)
      }
    } finally {
      const finished = draftRef.current
      // A reasoning model can burn the entire budget thinking and emit no
      // answer at all. Say so on the message instead of showing a blank reply.
      if (finished && !finished.aborted && !finished.content.trim() && finished.reasoning) {
        finished.truncated = true
      }
      flushSave()
      // The draft is mutated directly (abort flag, final timings), so the last
      // setMessages never saw them. Push the finished copy through state or the
      // "stopped" marker and the token counts only appear after a reload.
      if (finished) {
        setMessages((prev) => prev.map((m) => (m.id === finished.id ? { ...finished } : m)))
      }
      if (finished?.content.trim()) void inBackground(() => maybeTitle(conv, history, finished.content))
      // After the reply, not during it: extraction is a second model call.
      if (finished?.content.trim()) {
        void inBackground(() => db.listMessages(conv.id).then((all) => maybeCapture(conv, all)))
      }
      // Compaction is triggered by measured pressure — what the request actually
      // cost — and deliberately not gated on the reply having content: a reply
      // that ran out of budget is exactly the case where the next request most
      // needs a shorter history.
      // `promptTokens` is only the tokens processed fresh in the *last* round;
      // in a tool loop that is a small continuation. The context the request
      // actually occupied is fresh + cached, which is the number that matters
      // here — measured 15 + 2,253 on a round whose real prompt was 2.3k.
      if (finished?.stats?.promptTokens) {
        const used = (finished.stats.promptTokens ?? 0) + (finished.stats.cacheN ?? 0)
        void inBackground(() => maybeCompact(conv, used))
      }
      draftRef.current = null
      abortRef.current = null
      setStreaming(false)
      touch(conv)
    }
  }

  // ---- actions ----------------------------------------------------------
  async function select(id: string) {
    if (streaming) return
    const conv = conversations.find((c) => c.id === id)
    setActiveId(id)
    if (conv?.model && models.length) setModel(resolveModel(conv.model))
    setStats(null)
    setError(null)
    setMessages(await db.listMessages(id))
  }

  async function create() {
    if (streaming) return
    const conv: db.Conversation = {
      id: db.newId(),
      title: 'New conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model,
    }
    await db.putConversation(conv)
    setConversations((prev) => [conv, ...prev])
    setActiveId(conv.id)
    setMessages([])
    setStats(null)
    setError(null)
  }

  async function remove(id: string) {
    if (streaming) return
    await db.deleteConversation(id)
    // What was only ever true for this conversation goes with it — including
    // its summary, which would otherwise be an orphan record describing a
    // transcript that no longer exists.
    const stored = await db.listMemories()
    const own = stored.filter((m) => m.scope === 'conversation' && m.ownerId === id)
    for (const m of own) await db.deleteMemory(m.id)
    if (own.length) setMemories((prev) => prev.filter((m) => !own.some((o) => o.id === m.id)))
    const remaining = conversations.filter((c) => c.id !== id)
    setConversations(remaining)

    // Deleting the open conversation should land you on the next one, not on
    // an empty screen while other conversations sit in the sidebar.
    if (activeId === id) {
      const next = remaining[0] ?? null
      setActiveId(next?.id ?? null)
      if (next?.model && models.length) setModel(resolveModel(next.model))
      setMessages(next ? await db.listMessages(next.id) : [])
    }
  }

  // One write path for every field that belongs to a conversation. They all
  // used to spread the copy captured by their own render, so two changes in one
  // tick (or one landing while a reply streams) could undo each other. This
  // merges over the freshest object and updates the ref synchronously, so a
  // second change sees the first.
  async function patchConversation(patch: Partial<db.Conversation>): Promise<db.Conversation | null> {
    const base =
      convsRef.current.find((c) => c.id === activeId) ?? conversations.find((c) => c.id === activeId)
    if (!base) return null
    const updated = { ...base, ...patch, updatedAt: Date.now() }
    convsRef.current = convsRef.current.map((c) => (c.id === updated.id ? updated : c))
    await db.putConversation(updated)
    setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
    return updated
  }

  // The model belongs to the conversation, not to the app: switching model
  // mid-thread would silently change what the next reply comes from.
  async function changeModel(modelId: string) {
    setModel(modelId)
    await patchConversation({ model: modelId })
  }

  // The character belongs to the conversation, so switching it mid-thread only
  // affects what comes next. `undefined` inherits the app-wide character.
  async function setConversationCharacter(characterId: string | null | undefined) {
    await patchConversation({ characterId })
  }

  // Same three states as the character, because a profile is the same shape of
  // choice: `undefined` inherits the app-wide profile, `null` opts this
  // conversation out, an id pins it.
  async function setConversationProfile(profileId: string | null | undefined) {
    await patchConversation({ profileId })
  }

  // The tool profile belongs to the conversation, like the character: switching
  // it mid-thread only changes what the next reply can reach.
  async function setConversationTools(tools: db.ToolMode | undefined) {
    await patchConversation({ tools })
  }

  async function setSystemPrompt(text: string) {
    await patchConversation({ systemPrompt: text })
  }

  async function send(text: string, attachments: Attachment[] = []) {
    const trimmed = text.trim()
    // A file on its own is a valid message; the text is optional.
    if ((!trimmed && !attachments.length) || streaming) return

    setError(null)
    setStats(null)

    let conv = conversations.find((c) => c.id === activeId) ?? null
    if (!conv) {
      conv = {
        id: db.newId(),
        title: db.titleFrom(trimmed || attachments[0]?.name || 'Attachment'),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model,
      }
      await db.putConversation(conv)
      setConversations((prev) => [conv!, ...prev])
      setActiveId(conv.id)
    } else if (conv.title === 'New conversation') {
      conv = { ...conv, title: db.titleFrom(trimmed) }
      await db.putConversation(conv)
      setConversations((prev) => prev.map((c) => (c.id === conv!.id ? conv! : c)))
    }

    const now = Date.now()
    const userMsg: db.Message = {
      id: db.newId(),
      conversationId: conv.id,
      role: 'user',
      content: trimmed,
      createdAt: now,
      ...(attachments.length ? { attachments } : {}),
    }
    const assistantMsg: db.Message = {
      id: db.newId(),
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      createdAt: now + 1,
      characterId: resolveCharacter?.(conv.characterId)?.id ?? null,
    }

    const next = [...messages, userMsg]
    setMessages([...next, assistantMsg])
    await db.putMessage(userMsg)
    await db.putMessage(assistantMsg)

    await runTurn(conv, await buildHistory(next, conv), assistantMsg)
  }

  // Throw away the last reply and ask again with the same history.
  async function regenerate() {
    if (streaming) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return

    const lastIdx = messages.map((m) => m.role).lastIndexOf('assistant')
    if (lastIdx === -1) return

    await db.deleteMessage(messages[lastIdx].id)
    const kept = messages.slice(0, lastIdx)
    const assistantMsg: db.Message = {
      id: db.newId(),
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      characterId: resolveCharacter?.(conv.characterId)?.id ?? null,
    }

    setMessages([...kept, assistantMsg])
    await db.putMessage(assistantMsg)
    setStats(null)
    setError(null)

    await runTurn(conv, await buildHistory(kept, conv), assistantMsg)
  }

  // Rewrite the last user message and drop everything after it.
  async function editLast(text: string) {
    const trimmed = text.trim()
    if (!trimmed || streaming) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return

    const lastIdx = messages.map((m) => m.role).lastIndexOf('user')
    if (lastIdx === -1) return

    const edited: db.Message = { ...messages[lastIdx], content: trimmed }
    const dropped = messages.slice(lastIdx + 1)
    for (const m of dropped) await db.deleteMessage(m.id)
    await db.putMessage(edited)

    const kept = [...messages.slice(0, lastIdx), edited]
    const assistantMsg: db.Message = {
      id: db.newId(),
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      characterId: resolveCharacter?.(conv.characterId)?.id ?? null,
    }

    setMessages([...kept, assistantMsg])
    await db.putMessage(assistantMsg)
    setStats(null)
    setError(null)

    await runTurn(conv, await buildHistory(kept, conv), assistantMsg)
  }

  async function togglePin(id: string) {
    const conv = conversations.find((c) => c.id === id)
    if (!conv) return
    const updated = { ...conv, pinnedAt: conv.pinnedAt ? undefined : Date.now() }
    await db.putConversation(updated)
    const next = conversations
      .map((c) => (c.id === updated.id ? updated : c))
      .sort((a, b) => {
        const ap = a.pinnedAt ?? 0
        const bp = b.pinnedAt ?? 0
        if (ap && bp) return bp - ap
        if (ap) return -1
        if (bp) return 1
        return b.updatedAt - a.updatedAt
      })
    setConversations(next)
  }

  // ---- memory -----------------------------------------------------------
  // Runs after a reply, in the background. A capture is a second model call, so
  // it must never make the user wait for it.

  async function capture(conv: db.Conversation, msgs: db.Message[]) {
    if (!msgs.length) return { added: 0, removed: 0 }
    setCapturing(true)
    try {
      // Facts only: a summary is not a fact, and must never be offered to the
      // model as something it can retire.
      const existing = factsOf(await db.listMemories())
      const extraction = await extractMemories(resolveModel(conv.model) || model, msgs, existing)
      if (!extraction) return { added: 0, removed: 0 }

      const result = await applyExtraction(extraction, existing, conv.id)
      setMemories(await db.listMemories())
      await db.setMeta(`memory.capture.${conv.id}`, Date.now())
      return result
    } catch {
      // Background work: a failure here is not worth interrupting a conversation.
      return { added: 0, removed: 0 }
    } finally {
      setCapturing(false)
    }
  }

  async function maybeCapture(conv: db.Conversation, msgs: db.Message[]) {
    const last = (await db.getMeta<number>(`memory.capture.${conv.id}`)) ?? 0
    const fresh = msgs.filter((m) => m.createdAt > last)
    if (fresh.length < CAPTURE_EVERY) return
    await capture(conv, fresh)
  }

  // ---- compaction -------------------------------------------------------
  // The other half of memory: a long conversation keeps its beginning without
  // paying for it on every request. The summary goes into the same store the
  // facts use, so it is inspectable, editable and deletable in the same panel.

  async function condense(conv: db.Conversation, msgs?: db.Message[]) {
    const all = msgs ?? (await db.listMessages(conv.id))
    const summary = currentSummary(await db.listMemories(), conv.id)
    // Sized to the server's allocation: a summary that overflows the context
    // fails with a 400 and looks like the feature is broken.
    const ctx = models.find((m) => m.id === (resolveModel(conv.model) || model))?.ctx ?? 0
    setCondensing(true)
    try {
      const result = await compactConversation({
        conversationId: conv.id,
        model: resolveModel(conv.model) || model,
        messages: all,
        summary,
        ctx,
      })
      if (!result) return null
      setMemories(await db.listMemories())
      return result
    } catch {
      // Background work: a failed summary is not worth interrupting a chat.
      return null
    } finally {
      setCondensing(false)
    }
  }

  /** Fires only when the last request really did fill most of the context. */
  async function maybeCompact(conv: db.Conversation, promptTokens: number) {
    const ctx = models.find((m) => m.id === (resolveModel(conv.model) || model))?.ctx ?? 0
    if (!ctx || !promptTokens) return
    const msgs = await db.listMessages(conv.id)
    const summary = currentSummary(await db.listMemories(), conv.id)
    if (!shouldCompact({ ctx, promptTokens, messages: msgs, summary })) return
    await condense(conv, msgs)
  }

  // Fire-and-forget: a failed title request must never affect the reply.
  async function maybeTitle(conv: db.Conversation, history: ChatMessage[], reply: string) {
    const first = history.find((m) => m.role === 'user')
    if (!first || !reply.trim()) return
    if (history.filter((m) => m.role === 'user').length !== 1) return

    // A message with images carries content parts; the title only needs the text.
    const firstText =
      typeof first.content === 'string'
        ? first.content
        : first.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n')

    try {
      const title = await suggestTitle(BASE_URL, resolveModel(conv.model) || model, firstText, reply)
      if (!title) return
      // Same staleness trap as `touch`: the title call takes ~0.2s, long enough
      // for another field to change. Merge over the freshest copy.
      const latest = convsRef.current.find((c) => c.id === conv.id) ?? conv
      const updated = { ...latest, title, updatedAt: Date.now() }
      await db.putConversation(updated)
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
    } catch {
      // keep the truncated-first-message title
    }
  }

  // Re-read the model list. Used after the backend manager starts or stops
  // the server, since the app fetched models once at boot.
  async function reloadModels() {
    try {
      const list = await listModels(BASE_URL)
      setModels(list)
      setModel((current) => current || list[0]?.id || '')
    } catch {
      setModels([])
    }
  }

  // Re-read everything from IndexedDB. Used after an import.
  async function reload() {
    const convs = await db.listConversations()
    setConversations(convs)
    const current = convs.find((c) => c.id === activeId)
    if (current) {
      setMessages(await db.listMessages(current.id))
    } else if (convs[0]) {
      setActiveId(convs[0].id)
      setModel(resolveModel(convs[0].model) || model)
      setMessages(await db.listMessages(convs[0].id))
    } else {
      setActiveId(null)
      setMessages([])
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null

  return {
    conversations,
    activeId,
    activeConversation,
    messages,
    models,
    model,
    setModel: changeModel,
    setSystemPrompt,
    setConversationCharacter,
    setConversationProfile,
    setConversationTools,
    streaming,
    stats,
    error,
    select,
    create,
    remove,
    send,
    regenerate,
    editLast,
    stop,
    reload,
    reloadModels,
    togglePin,
    memories,
    capturing,
    condensing,
    condenseNow: async () => {
      const conv = conversations.find((c) => c.id === activeId)
      if (!conv) return null
      return condense(conv)
    },
    captureNow: async () => {
      const conv = conversations.find((c) => c.id === activeId)
      if (!conv) return { added: 0, removed: 0 }
      return capture(conv, await db.listMessages(conv.id))
    },
    refreshMemories: async () => setMemories(await db.listMemories()),
  }
}
