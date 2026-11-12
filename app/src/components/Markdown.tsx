import { memo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

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

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre: Pre,
        a: (props: any) => <a {...props} target="_blank" rel="noreferrer" />,
      }}
    >
      {tidy(text)}
    </ReactMarkdown>
  )
}

export default memo(Markdown)
