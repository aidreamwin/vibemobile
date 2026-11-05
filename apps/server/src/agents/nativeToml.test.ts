import { describe, expect, it } from 'vitest'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'
import { editTomlValue } from './nativeToml.js'

const parse = (text: string) => getStaticTOMLValue(parseTOML(text))

describe('native TOML edits', () => {
  it('preserves unrelated bytes, comments, multiline strings and large integer spelling', () => {
    const original =
      '# header\r\nmodel = "old" # model note\r\nlarge = 9_223_372_036_854_775_807\r\ntext = """\r\n[model_providers.custom]\r\nbase_url = fake\r\n"""\r\n[model_providers."custom"] # real provider\r\nbase_url = "https://old.test" # url note\r\n[mcp_servers.x]\r\ncommand = "test"\r\n'
    const updated = editTomlValue(
      editTomlValue(original, ['model'], 'new'),
      ['model_providers', 'custom', 'base_url'],
      'https://new.test',
    )
    expect(updated).toBe(
      original.replace('model = "old"', 'model = "new"').replace('"https://old.test"', '"https://new.test"'),
    )
  })

  it('inserts missing root and provider fields into the correct scope', () => {
    let text = '# header\n[model_providers.custom]\nname="custom" # keep\n[mcp_servers.x]\ncommand="test"\n'
    text = editTomlValue(text, ['model'], 'new')
    text = editTomlValue(text, ['model_providers', 'custom', 'base_url'], 'https://example.test')
    expect(parse(text)).toMatchObject({
      model: 'new',
      model_providers: { custom: { name: 'custom', base_url: 'https://example.test' } },
      mcp_servers: { x: { command: 'test' } },
    })
    expect(text).toContain('name="custom" # keep')
  })

  it('supports dotted and inline provider tables, including deletion', () => {
    const original = 'model_providers = { custom = { name="keep", base_url="old", wire_api="responses" } }\n'
    const updated = editTomlValue(original, ['model_providers', 'custom', 'base_url'], 'new')
    expect(updated).toBe(original.replace('base_url="old"', 'base_url="new"'))
    const removed = editTomlValue(updated, ['model_providers', 'custom', 'base_url'], undefined)
    expect(parse(removed)).toMatchObject({ model_providers: { custom: { name: 'keep', wire_api: 'responses' } } })
    const inserted = editTomlValue(removed, ['model_providers', 'custom', 'base_url'], 'restored')
    expect(parse(inserted)).toMatchObject({ model_providers: { custom: { base_url: 'restored' } } })
    const empty = editTomlValue(
      'model_providers.custom = { base_url="old" }\n',
      ['model_providers', 'custom', 'base_url'],
      undefined,
    )
    expect(parse(empty)).toMatchObject({ model_providers: { custom: {} } })
  })

  it('creates missing config fields and treats unchanged values as a no-op', () => {
    let text = editTomlValue('', ['model'], 'new')
    text = editTomlValue(text, ['model_providers', 'custom', 'base_url'], 'https://example.test')
    expect(parse(text)).toMatchObject({
      model: 'new',
      model_providers: { custom: { base_url: 'https://example.test' } },
    })
    expect(editTomlValue(text, ['model'], 'new')).toBe(text)
    expect(editTomlValue(text, ['missing'], undefined)).toBe(text)
  })
})
