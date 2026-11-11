import { useState } from 'react'

type Props = { name: string; src?: string; size?: number }

// An uploaded image if there is one, otherwise initials on a colour derived
// from the name: no uploads required, and the same character always looks the same.
export default function Avatar({ name, src, size = 24 }: Props) {
  // A stored avatar is a URL served by the manager; if it is not running the
  // image 404s, so fall back to initials rather than showing a broken icon.
  const [failed, setFailed] = useState(false)

  if (src && !failed) {
    return (
      <img
        className="avatar avatar-img"
        src={src}
        alt=""
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    )
  }

  const initials =
    name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'

  let hue = 0
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360

  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `hsl(${hue} 38% 36%)`,
      }}
    >
      {initials}
    </span>
  )
}
