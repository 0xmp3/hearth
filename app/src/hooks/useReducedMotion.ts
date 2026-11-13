import { useEffect, useState } from 'react'

/**
 * Whether the system is asking for less motion.
 *
 * On Windows this is the "Animation effects" switch, and it is off on a lot of
 * performance-tuned machines — which means a user can turn on an animated
 * feature and see nothing move, with no clue why. Anything that offers motion
 * should say so when this is true.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return reduced
}
