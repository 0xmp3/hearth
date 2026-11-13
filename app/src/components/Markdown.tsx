import { Children, isValidElement, memo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { TextStyle } from '../lib/db'

// Every fenced block gets its own copy button. Reading innerText off the
// rendered <pre> means we copy exactly what the user sees, highlight spans
// and all, without re-parsing the markdown source.
function Pre(props: any) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText ?? '')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard blocked (insecure context) — leave the button alone
    }
  }

  return (
    <div className="code-wrap">
      <button className="copy" onClick={copy} type="button">
        {copied ? 'copied' : 'copy'}
      </button>
      <pre ref={ref} {...props} />
    </div>
  )
}

// The model pads, and every tool round adds a paragraph break, so three or more
// newlines is always noise. Fenced code is left exactly as written.
function tidy(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/\n{3,}/g, '\n\n')))
    .join('')
}

/**
 * How long an emphasised phrase may be before it is left alone.
 *
 * The point of the effect is a word or a short phrase — the thing the model
 * reached for emphasis on. A whole bolded sentence is an explanation, not a
 * flourish, and dressing it would be the "animate the entire reply" failure the
 * feature exists to avoid. Measured in characters of rendered text, so nested
 * markup counts as what the reader actually sees.
 */
const FX_MAX_CHARS = 60

function textLength(node: ReactNode): number {
  let n = 0
  Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') n += String(child).length
    else if (isValidElement(child)) n += textLength((child.props as { children?: ReactNode }).children)
  })
  return n
}

type Props = {
  text: string
  /**
   * How to dress emphasis. `off` renders plain bold and italics, which is what
   * every conversation did before v1.40 and what a coding thread still wants.
   */
  fx?: TextStyle
}

function Markdown({ text, fx = 'off' }: Props) {
  // The effect classes are only attached when the phrase is short enough to be
  // a flourish. Everything else falls through to the plain element, so a long
  // reply costs exactly what it did before.
  const dress = (tag: 'strong' | 'em', props: any) => {
    const { children, ...rest } = props
    if (fx === 'off' || textLength(children) > FX_MAX_CHARS) {
      return tag === 'strong' ? <strong {...rest}>{children}</strong> : <em {...rest}>{children}</em>
    }
    const base = tag === 'strong' ? 'fx-strong' : 'fx-soft'
    const className = fx === 'expressive' ? `${base} fx-move` : base
    return tag === 'strong' ? (
      <strong {...rest} className={className}>{children}</strong>
    ) : (
      <em {...rest} className={className}>{children}</em>
    )
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre: Pre,
        a: (props: any) => <a {...props} target="_blank" rel="noreferrer" />,
        strong: (props: any) => dress('strong', props),
        em: (props: any) => dress('em', props),
      }}
    >
      {tidy(text)}
    </ReactMarkdown>
  )
}

export default memo(Markdown)
