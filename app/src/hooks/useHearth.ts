// All the state. Components render; this decides.
// The turn driver is injected, so swapping chat for an agent is a one-line change.

import { useEffect, useRef, useState } from 'react'
import * as db from '../lib/db'
import { listModels, type ModelInfo } from '../lib/models'
import { chatTurn, type TurnDriver } from '../lib/turn'
import { BASE_URL, SYSTEM_PROMPT } from '../lib/config'
import { suggestTitle } from '../lib/title'
import type { ChatMessage, ContentPart, Stats } from '../lib/stream'
import { toDataUrl, type Attachment } from '../lib/attachments'

export function useHearth(
  turn: TurnDriver = chatTurn,
  resolvePersona?: (personaId: string | null | undefined) => db.Persona | null,
  maxTokens = 2048,
) {
  const [conversations, setConversations] = useState<db.Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<db.Message[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [model, setModel] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      try {
        const [list, convs] = await Promise.all([listModels(BASE_URL), db.listConversations()])
        if (cancelled) return
        setModels(list)
        setModel(list[0]?.id ?? '')
        setConversations(convs)
        if (convs[0]) {
          setActiveId(convs[0].id)
          setModel(convs[0].model || list[0]?.id || '')
          setMessages(await db.listMessages(convs[0].id))
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
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
    // Persona first (who you are), then the conversation's own prompt (what
    // this chat is about). Either can be empty.
    const persona = resolvePersona?.(conv.personaId)?.systemPrompt?.trim()
    const system = [persona, conv.systemPrompt?.trim() || SYSTEM_PROMPT]
      .filter(Boolean)
      .join('\n\n')
    return [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      // An assistant turn that produced no text (thinking ate the budget, or
      // the user stopped it before the first token) is noise to the model and
      // makes it reason about "the empty response" instead of the question.
      ...(await Promise.all(
        msgs
          .filter((m) => m.content.trim().length > 0 || (m.attachments?.length ?? 0) > 0)
          .map(toChatMessage),
      )),
    ]
  }

  function touch(conv: db.Conversation) {
    const updated = { ...conv, updatedAt: Date.now() }
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
      const activeModel = conv.model || model
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
              model: conv.model || model,
            }
          }
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
      if (finished?.content.trim()) void maybeTitle(conv, history, finished.content)
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
    if (conv?.model) setModel(conv.model)
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
    const remaining = conversations.filter((c) => c.id !== id)
    setConversations(remaining)

    // Deleting the open conversation should land you on the next one, not on
    // an empty screen while other conversations sit in the sidebar.
    if (activeId === id) {
      const next = remaining[0] ?? null
      setActiveId(next?.id ?? null)
      if (next?.model) setModel(next.model)
      setMessages(next ? await db.listMessages(next.id) : [])
    }
  }

  // The model belongs to the conversation, not to the app: switching model
  // mid-thread would silently change what the next reply comes from.
  async function changeModel(modelId: string) {
    setModel(modelId)
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return
    const updated = { ...conv, model: modelId }
    await db.putConversation(updated)
    setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
  }

  // The character belongs to the conversation, so switching it mid-thread only
  // affects what comes next.
  async function setConversationPersona(personaId: string | null) {
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return
    const updated = { ...conv, personaId }
    await db.putConversation(updated)
    setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
  }

  async function setSystemPrompt(text: string) {
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return
    const updated = { ...conv, systemPrompt: text }
    await db.putConversation(updated)
    setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
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
      personaId: resolvePersona?.(conv.personaId)?.id ?? null,
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
      personaId: resolvePersona?.(conv.personaId)?.id ?? null,
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
      personaId: resolvePersona?.(conv.personaId)?.id ?? null,
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
      const title = await suggestTitle(BASE_URL, conv.model || model, firstText, reply)
      if (!title) return
      const updated = { ...conv, title, updatedAt: Date.now() }
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
      setModel(convs[0].model || model)
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
    setConversationPersona,
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
  }
}
