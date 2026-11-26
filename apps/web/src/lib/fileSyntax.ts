import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { createLowlight } from 'lowlight'

const grammars = { bash, c, cpp, css, ini, javascript, json, markdown, python, typescript, xml, yaml }
type Language = keyof typeof grammars
type HighlightNode = ReturnType<typeof highlighter.highlight>['children'][number]

const highlighter = createLowlight(grammars)
const languages = new Map<string, Language>([
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['c', 'c'],
  ['h', 'c'],
  ['cc', 'cpp'],
  ['cpp', 'cpp'],
  ['cxx', 'cpp'],
  ['hh', 'cpp'],
  ['hpp', 'cpp'],
  ['hxx', 'cpp'],
  ['css', 'css'],
  ['ini', 'ini'],
  ['toml', 'ini'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['py', 'python'],
  ['pyw', 'python'],
  ['pyi', 'python'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['html', 'xml'],
  ['htm', 'xml'],
  ['xml', 'xml'],
  ['svg', 'xml'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
])

// Bound work on minified files and unusually long lines. Plain source is still readable.
const MAX_HIGHLIGHT_CHARACTERS = 200_000

export interface SourceToken {
  text: string
  className?: string
  offset: number
}

export function highlightFileRows(path: string, rows: string[]): SourceToken[][] | null {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase()
  const language = extension ? languages.get(extension) : undefined
  if (!language) return null
  const source = rows.join('\n')
  if (source.length > MAX_HIGHLIGHT_CHARACTERS) return null

  const lines: SourceToken[][] = [[]]
  let currentLine = lines[0]
  let offset = 0

  // Tokenize before splitting to retain multiline comments and strings across the gutter rows.
  function visit(node: HighlightNode, className?: string) {
    if (node.type === 'element') {
      const ownClasses = node.properties.className
      const nestedClass = Array.isArray(ownClasses) ? [className, ...ownClasses].filter(Boolean).join(' ') : className
      for (const child of node.children) visit(child, nestedClass)
    } else if (node.type === 'text') {
      for (const [index, text] of node.value.split('\n').entries()) {
        if (index > 0) {
          currentLine = []
          lines.push(currentLine)
          offset += 1
        }
        if (text) currentLine.push({ text, className, offset })
        offset += text.length
      }
    }
  }

  try {
    for (const child of highlighter.highlight(language, source).children) visit(child)
  } catch {
    return null
  }
  return lines.length === rows.length ? lines : null
}
