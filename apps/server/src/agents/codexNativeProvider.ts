import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'

/** Keep managed credentials under the native provider key that owns existing threads. */
export function codexNativeModelProvider(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): string {
  let text: string
  try {
    text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'openai'
    throw err
  }
  const config = getStaticTOMLValue(parseTOML(text)) as Record<string, unknown>
  return typeof config.model_provider === 'string' && config.model_provider ? config.model_provider : 'openai'
}
