// All the state. Components render; this decides.
// The turn driver is injected, so swapping chat for an agent is a one-line change.

import { useEffect, useRef, useState } from 'react'
import * as db from '../lib/db'
import { listModels, type ModelInfo } from '../lib/models'
import { chatTurn, type TurnDriver } from '../lib/turn'
import { BASE_URL, SYSTEM_PROMPT } from '../lib/config'
import type { ChatMessage, Stats } from '../lib/stream'

export function useHearth(turn: TurnDriver = chatTurn) {
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
  function buildHistory(msgs: db.Message[], conv: db.Conversation): ChatMessage[] {
    const system = conv.systemPrompt?.trim() || SYSTEM_PROMPT
    return [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      // An assistant turn that produced no text (thinking ate the budget, or
      // the user stopped it before the first token) is noise to the model and
      // makes it reason about "the empty response" instead of the question.
      ...msgs
        .filter((m) => m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content })),
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
      await turn({
        model: conv.model || model,
        messages: history,
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
          setStats(s)
          if (draftRef.current) {
            draftRef.current.stats = { tokPerSec: s.tokPerSec, completionTokens: s.completionTokens }
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
      flushSave()
      // The abort flag is set on the draft object, not through setMessages,
      // so without this the "stopped" marker only appeared after a reload.
      if (finished?.aborted) {
        setMessages((prev) => prev.map((m) => (m.id === finished.id ? { ...finished } : m)))
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
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (activeId === id) {
      setActiveId(null)
      setMessages([])
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

  async function setSystemPrompt(text: string) {
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return
    const updated = { ...conv, systemPrompt: text }
    await db.putConversation(updated)
    setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || streaming) return

    setError(null)
    setStats(null)

    let conv = conversations.find((c) => c.id === activeId) ?? null
    if (!conv) {
      conv = {
        id: db.newId(),
        title: db.titleFrom(trimmed),
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
    }
    const assistantMsg: db.Message = {
      id: db.newId(),
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      createdAt: now + 1,
    }

    const next = [...messages, userMsg]
    setMessages([...next, assistantMsg])
    await db.putMessage(userMsg)
    await db.putMessage(assistantMsg)

    await runTurn(conv, buildHistory(next, conv), assistantMsg)
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
    }

    setMessages([...kept, assistantMsg])
    await db.putMessage(assistantMsg)
    setStats(null)
    setError(null)

    await runTurn(conv, buildHistory(kept, conv), assistantMsg)
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
    }

    setMessages([...kept, assistantMsg])
    await db.putMessage(assistantMsg)
    setStats(null)
    setError(null)

    await runTurn(conv, buildHistory(kept, conv), assistantMsg)
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
  }
}
