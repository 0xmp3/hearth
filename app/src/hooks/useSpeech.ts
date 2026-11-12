// One reply, spoken. The heavy lifting is in lib/speech; this keeps the state a
// component needs: which message is talking, whether it has started yet, and a
// single toggle.
//
// Starting a second message stops the first — speech you cannot interrupt is
// speech you turn off.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '../lib/db'
import { speak as speakText, stop as stopSpeech } from '../lib/speech'

type Options = {
  /** Manager reports the engine ready and the user wants spoken replies. */
  enabled: boolean
  /** Which clip to use for a message, from character → global → first. */
  resolveVoice: (message: Message) => string
}

export function useSpeech({ enabled, resolveVoice }: Options) {
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const controller = useRef<AbortController | null>(null)

  const stop = useCallback(() => {
    controller.current?.abort()
    controller.current = null
    stopSpeech()
    setSpeakingId(null)
    setStarting(false)
  }, [])

  const toggle = useCallback(
    (message: Message) => {
      if (speakingId === message.id) {
        stop()
        return
      }
      stop()
      if (!enabled || !message.content.trim()) return

      const ac = new AbortController()
      controller.current = ac
      setSpeakingId(message.id)
      setStarting(true)

      void speakText(
        message.content,
        resolveVoice(message),
        (progress) => {
          if (controller.current !== ac) return
          if (progress) setStarting(progress.starting)
          else {
            setSpeakingId(null)
            setStarting(false)
          }
        },
        ac.signal,
      )
    },
    [enabled, resolveVoice, speakingId, stop],
  )

  // A stopped turn, a deleted conversation, a closed tab: nothing should keep
  // talking. Unmount is the only signal we get for the last two.
  useEffect(() => () => stop(), [stop])

  return { speakingId, starting, toggle, stop }
}
