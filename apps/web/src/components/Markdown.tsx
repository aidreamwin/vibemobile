import { memo, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseFileRef, type FileRef } from '../lib/fileLink'

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="group relative my-3 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-secondary px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span>{language || 'text'}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-[11px] text-foreground/90 transition-colors active:bg-raised-hover"
        >
          {copied ? (
            <>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-3.5 w-3.5 text-success"
              >
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-success">已复制</span>
            </>
          ) : (
            <>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="h-3.5 w-3.5 text-muted-foreground"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" strokeLinecap="round" strokeLinejoin="round" />
                <path
                  d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      {/* No padding utilities here: `.md pre` is unlayered and would beat
          them, so the padding lives in the `.md-code-block` rule instead. */}
      <pre className="md-code-block max-h-96 font-mono text-[12.5px] leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export interface MarkdownProps {
  text: string
  /**
   * The session's working directory — what the agent's relative links are
   * relative to. Without it they are not file links and are left alone.
   */
  cwd?: string | null
  /** Given, a file reference opens in the app instead of on the page's origin. */
  onOpenFile?: (ref: FileRef) => void
}

/**
 * Memoized on `text` so a long transcript does not re-parse every message on
 * each animation frame while one message is still streaming.
 */
const Markdown = memo(
  function Markdown({ text, cwd, onOpenFile }: MarkdownProps) {
    return (
      <div className="md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          /* react-markdown blanks any destination whose first colon comes
             before its first slash unless the scheme is http/https/irc/mailto/
             xmpp — and `D:/code/x.md` has no scheme at all, so it arrived here
             as `href=""` and the reference was unreachable even before the
             browser resolved it. `/D:/…` slipped past that test only by
             accident of the leading slash. Our own classification decides: a
             file reference keeps its text (it is never navigated to), and
             everything else goes through the default transform, so
             `javascript:` is still stripped. */
          urlTransform={(url) => (parseFileRef(url, cwd) ? url : defaultUrlTransform(url))}
          components={{
            /* The agents link their file references the way a webpage links a
               page — `[testing.md](rules/testing.md)`,
               `[测试规范](/D:/code/…/testing.md:10)` — and a browser resolves
               both against this origin, so tapping one asked the VibeMobile
               server for a path it has no route for. Those open in the app
               instead; everything else (real http links, anchors, and any
               relative link we cannot resolve) keeps the old behaviour of
               going to a new tab rather than navigating the PWA away. */
            a: ({ node, href, children, ...props }) => {
              // `open` is held in a const so the narrowing survives into the
              // handler, where TypeScript would otherwise widen it again.
              const open = onOpenFile
              if (open && typeof href === 'string') {
                const ref = parseFileRef(href, cwd)
                if (ref) {
                  return (
                    <a
                      {...props}
                      href={href}
                      onClick={(event) => {
                        event.preventDefault()
                        open(ref)
                      }}
                    >
                      {children}
                    </a>
                  )
                }
              }
              return (
                <a {...props} href={href} target="_blank" rel="noreferrer noopener">
                  {children}
                </a>
              )
            },
            /* Block-vs-inline is decided HERE, by the wrapper, not by a flag on
               `code`. react-markdown 9 removed the `inline` boolean the old
               `code` override tested — it was always `undefined`, so `!inline`
               was always true and the test collapsed to "has a language class
               or contains a newline". A fenced block with no language and one
               line of content therefore rendered as inline code. Position is
               the thing that actually distinguishes them: react-markdown only
               ever wraps block code in a `<pre>`.

               Handling it here also removes the wrapper, which matters inside
               `.md` — those element-level `pre` rules are unlayered, so they
               beat CodeBlock's Tailwind utilities and drew a second bordered
               box around the first. */
            pre({ children }) {
              const child = (Array.isArray(children) ? children[0] : children) as any
              const className: string = child?.props?.className ?? ''
              const raw = child?.props?.children
              const match = /language-(\w+)/.exec(className)
              return (
                <CodeBlock
                  language={match ? match[1] : ''}
                  code={(Array.isArray(raw) ? raw.join('') : String(raw ?? '')).replace(/\n$/, '')}
                />
              )
            },
            code({ node, className, children, ...props }: any) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              )
            },
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    )
  },
  (prev, next) => prev.text === next.text && prev.cwd === next.cwd && prev.onOpenFile === next.onOpenFile,
)

export default Markdown
