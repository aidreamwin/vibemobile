import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileText, resolveDirectory, writeFileText, WorkspaceError } from './workspace.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibemobile-workspace-'))
  temporaryDirectories.push(root)
  await fs.mkdir(path.join(root, 'project', 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'project', 'file.txt'), 'content')
  return path.join(root, 'project')
}

describe('resolveDirectory', () => {
  it('accepts an existing subdirectory in an allowed root', async () => {
    const root = await fixture()
    await expect(resolveDirectory([root], path.join(root, 'src'))).resolves.toBe(path.join(root, 'src'))
  })

  it('rejects files and paths outside the allowed roots', async () => {
    const root = await fixture()
    await expect(resolveDirectory([root], path.join(root, 'file.txt'))).rejects.toMatchObject({
      status: 404,
    })
    await expect(resolveDirectory([root], path.dirname(root))).rejects.toBeInstanceOf(WorkspaceError)
  })
})

describe('writeFileText', () => {
  /** Platform-specific, so the CRLF cases are asserted as bytes either way. */
  const crlf = (text: string) => text.replace(/\n/g, '\r\n')

  it('restores the line endings a textarea stripped', async () => {
    const root = await fixture()
    const file = path.join(root, 'win.txt')
    await fs.writeFile(file, crlf('one\ntwo\nthree\n'))

    // The wire carries LF — that is all a browser textarea can produce.
    await writeFileText([root], { path: file, text: 'one\ntwo\nTHREE\n' })

    // Asserted on the raw bytes, not on the decoded string: a string compare
    // would pass even if every line ending had been rewritten.
    const raw = await fs.readFile(file)
    expect(raw.includes('\r\n')).toBe(true)
    expect(raw.toString('utf8')).toBe(crlf('one\ntwo\nTHREE\n'))
  })

  it('does not introduce CRLF into an LF file', async () => {
    const root = await fixture()
    const file = path.join(root, 'unix.txt')
    await fs.writeFile(file, 'one\ntwo\n')
    await writeFileText([root], { path: file, text: 'one\nTWO\n' })
    expect(await fs.readFile(file, 'utf8')).toBe('one\nTWO\n')
  })

  it('accepts an empty string, which is how a file is cleared', async () => {
    const root = await fixture()
    const file = path.join(root, 'empty.txt')
    await fs.writeFile(file, 'gone soon')
    const after = await writeFileText([root], { path: file, text: '' })
    expect(after.text).toBe('')
    expect(after.bytes).toBe(0)
  })

  it('returns the file as it is on disk, with a fresh rev', async () => {
    const root = await fixture()
    const file = path.join(root, 'file.txt')
    const before = await readFileText([root], file)
    const after = await writeFileText([root], { path: file, text: 'changed', rev: before.rev })
    expect(after.text).toBe('changed')
    expect(after.rev).toBeDefined()
    expect(after.rev).not.toBe(before.rev)
    // The new rev must be the one a second read produces, or a client that
    // saves twice without re-reading would get a spurious 409.
    expect(after.rev).toBe((await readFileText([root], file)).rev)
  })

  it('refuses a save when the file changed underneath it', async () => {
    const root = await fixture()
    const file = path.join(root, 'file.txt')
    const before = await readFileText([root], file)
    await fs.writeFile(file, 'the agent got there first')

    await expect(writeFileText([root], { path: file, text: 'from the phone', rev: before.rev })).rejects.toMatchObject({
      status: 409,
      code: 'file_changed',
    })
    expect(await fs.readFile(file, 'utf8')).toBe('the agent got there first')
  })

  it('saves without a rev, for a client that has none to offer', async () => {
    const root = await fixture()
    const file = path.join(root, 'file.txt')
    await expect(writeFileText([root], { path: file, text: 'no rev' })).resolves.toMatchObject({
      text: 'no rev',
    })
  })

  it('never creates a file', async () => {
    const root = await fixture()
    const missing = path.join(root, 'nope.txt')
    await expect(writeFileText([root], { path: missing, text: 'x' })).rejects.toMatchObject({ status: 404 })
    await expect(fs.stat(missing)).rejects.toBeTruthy()
  })

  it('refuses a directory', async () => {
    const root = await fixture()
    await expect(writeFileText([root], { path: root, text: 'x' })).rejects.toMatchObject({ status: 404 })
  })

  it('refuses to escape the workspace roots', async () => {
    const root = await fixture()
    const outside = path.join(path.dirname(root), 'outside.txt')
    await fs.writeFile(outside, 'original')
    await expect(writeFileText([root], { path: outside, text: 'replaced' })).rejects.toBeInstanceOf(WorkspaceError)
    expect(await fs.readFile(outside, 'utf8')).toBe('original')
  })

  it('refuses a binary file', async () => {
    const root = await fixture()
    const file = path.join(root, 'bin.dat')
    await fs.writeFile(file, Buffer.from([0x41, 0x00, 0x42]))
    await expect(writeFileText([root], { path: file, text: 'text' })).rejects.toMatchObject({ status: 415 })
  })

  it('refuses a file that is not UTF-8', async () => {
    // GBK-encoded 中文. Decoding it to a string yields replacement characters,
    // so writing the string back would corrupt the file for good — the one
    // silent encoding failure there is.
    const root = await fixture()
    const file = path.join(root, 'gbk.txt')
    await fs.writeFile(file, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))
    await expect(writeFileText([root], { path: file, text: 'text' })).rejects.toMatchObject({ status: 415 })
    expect((await fs.readFile(file)).toString('hex')).toBe('d6d0cec40a')
  })

  it('refuses a file above the read ceiling', async () => {
    const root = await fixture()
    const file = path.join(root, 'big.txt')
    await fs.writeFile(file, 'x'.repeat(512 * 1024 + 1))
    await expect(writeFileText([root], { path: file, text: 'small' })).rejects.toMatchObject({ status: 413 })
  })

  it('leaves no temp file behind, and none on a failure either', async () => {
    const root = await fixture()
    const file = path.join(root, 'file.txt')
    const before = await readFileText([root], file)
    await writeFileText([root], { path: file, text: 'ok' })
    await expect(writeFileText([root], { path: file, text: 'stale', rev: before.rev })).rejects.toMatchObject({
      status: 409,
    })

    // Dotfiles, which is what the browser hides — the point of naming them that
    // way is that a crashed write cannot leave anything the user can see.
    const leftovers = (await fs.readdir(root)).filter((name) => name.includes('vbtmp'))
    expect(leftovers).toEqual([])
  })
})
