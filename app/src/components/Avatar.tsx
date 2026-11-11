type Props = { name: string; src?: string; size?: number }

// An uploaded image if there is one, otherwise initials on a colour derived
// from the name: no uploads required, and the same character always looks the same.
export default function Avatar({ name, src, size = 24 }: Props) {
  if (src) {
    return (
      <img
        className="avatar avatar-img"
        src={src}
        alt=""
        style={{ width: size, height: size }}
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
