import { parseTOML, getStaticTOMLValue, type AST } from 'toml-eslint-parser'

/** Replace only the requested TOML scalar, retaining comments and every unrelated byte. */
export function editTomlValue(text: string, keys: string[], value: string | undefined): string {
  const ast = parseTOML(text)
  const entries: { node: AST.TOMLKeyValue; keys: string[] }[] = []
  const visit = (nodes: AST.TOMLKeyValue[], prefix: string[]) => {
    for (const node of nodes) {
      const entryKeys = [...prefix, ...getStaticTOMLValue(node.key)]
      entries.push({ node, keys: entryKeys })
      if (node.value.type === 'TOMLInlineTable') visit(node.value.body, entryKeys)
    }
  }
  const root = ast.body[0]
  for (const node of root.body) {
    if (node.type === 'TOMLTable') visit(node.body, node.resolvedKey.map(String))
    else visit([node], [])
  }
  const equal = (left: string[], right: string[]) =>
    left.length === right.length && left.every((key, index) => key === right[index])
  const found = entries.find((entry) => equal(entry.keys, keys))
  let result: string
  if (found) {
    const node = found.node
    if (getStaticTOMLValue(node.value) === value) return text
    if (value !== undefined)
      result = text.slice(0, node.value.range[0]) + JSON.stringify(value) + text.slice(node.value.range[1])
    else {
      let [start, end] = node.range
      if (node.parent.type === 'TOMLInlineTable') {
        const siblings = node.parent.body
        const index = siblings.indexOf(node)
        const next = siblings[index + 1]
        const previous = siblings[index - 1]
        if (next) end = next.range[0]
        else if (previous) start = previous.range[1]
      }
      result = text.slice(0, start) + text.slice(end)
    }
  } else {
    if (value === undefined) return text
    const prefixOf = (prefix: string[]) =>
      prefix.length < keys.length && prefix.every((key, index) => key === keys[index])
    const inline = entries
      .filter((entry) => entry.node.value.type === 'TOMLInlineTable' && prefixOf(entry.keys))
      .sort((left, right) => right.keys.length - left.keys.length)[0]
    const assignment = (remaining: string[]) =>
      `${remaining.map((key) => JSON.stringify(key)).join('.')} = ${JSON.stringify(value)}`
    if (inline && inline.node.value.type === 'TOMLInlineTable') {
      const at = inline.node.value.range[1] - 1
      result =
        text.slice(0, at) +
        `${inline.node.value.body.length ? ', ' : ''}${assignment(keys.slice(inline.keys.length))}` +
        text.slice(at)
    } else {
      const tables = root.body.filter((node): node is AST.TOMLTable => node.type === 'TOMLTable')
      const table = tables
        .filter((node) => node.kind === 'standard' && prefixOf(node.resolvedKey.map(String)))
        .sort((left, right) => right.resolvedKey.length - left.resolvedKey.length)[0]
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      let at: number
      if (table) {
        const newline = text.indexOf('\n', table.range[1])
        at = newline === -1 ? text.length : newline + 1
      } else at = tables[0] ? text.lastIndexOf('\n', tables[0].range[0] - 1) + 1 : text.length
      const prefix = at > 0 && text[at - 1] !== '\n' ? eol : ''
      result =
        text.slice(0, at) + prefix + assignment(keys.slice(table?.resolvedKey.length ?? 0)) + eol + text.slice(at)
    }
  }
  // Reject unsupported layouts before any disk write.
  parseTOML(result)
  return result
}
