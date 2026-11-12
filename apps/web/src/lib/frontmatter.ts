import { isMap, isScalar, isSeq, parseDocument, type ParsedNode } from 'yaml'

export interface FrontmatterEntry {
  key: string
  /** A scalar, a flat list, or the original YAML for a structured value. */
  value: string | string[]
}

export type ParsedDocument = { body: string } & ({ meta: FrontmatterEntry[] } | { meta: null; raw: string })

const FENCE = /^(?:---|\.\.\.)[ \t]*$/
const MAPPING_LINE = /^[^\s#].*?:(?:[ \t]|$)/m

/** Split a leading YAML mapping without ever consuming a partially read header. */
export function splitFrontmatter(text: string): ParsedDocument | null {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = source.split(/\r?\n/)
  if (!/^---[ \t]*$/.test(lines[0])) return null

  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (end < 0) return null

  const raw = lines.slice(1, end).join('\n')
  const body = lines.slice(end + 1).join('\n')
  const doc = parseDocument(raw)
  // A horizontal rule around prose is still Markdown. An invalid mapping is
  // shown verbatim, so a valid field cannot hide an earlier malformed field.
  if (doc.errors.length || !isMap(doc.contents)) {
    return MAPPING_LINE.test(raw) ? { meta: null, raw, body } : null
  }

  const meta: FrontmatterEntry[] = []
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key)) return { meta: null, raw, body }
    meta.push({ key: String(pair.key.value), value: displayValue(pair.value, raw) })
  }
  return meta.length ? { meta, body } : null
}

function displayValue(node: ParsedNode | null, source: string): string | string[] {
  if (isScalar(node)) return String(node.value ?? '')
  if (isSeq(node)) {
    const items = node.items
    if (items.every((item) => isScalar(item))) return items.map((item) => String(item.value ?? ''))
  }
  // Keep nested mappings, complex lists and aliases in their source form.
  // Reading the AST instead of expanding aliases also avoids alias explosions.
  if (!node?.range) return ''
  const start = node.range[0]
  const indentation = source.slice(source.lastIndexOf('\n', start - 1) + 1, start)
  const value = source.slice(start, node.range[1]).trimEnd()
  return /^[ \t]+$/.test(indentation) ? value.replaceAll(`\n${indentation}`, '\n') : value
}
