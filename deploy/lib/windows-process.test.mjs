import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import { windowsDescendants, reapWindowsDescendants } from './windows-process.mjs'
import { ecosystemSource } from './common.mjs'

test('generated PM2 configuration requests graceful shutdown and process-tree cleanup', () => {
  const source = ecosystemSource({ name: 'test', cwd: 'test', script: 'test.js', envFile: 'test.env' })
  assert.match(source, /shutdown_with_message: true/)
  assert.match(source, /treekill: true/)
})

test('Windows cleanup releases an orphan listener and preserves unrelated or reused PIDs', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async () => {
  const listener = `const net = require('node:net'); const server = net.createServer();
server.listen(0, '127.0.0.1', () => process.send({ pid: process.pid, port: server.address().port }));`
  const root = spawn(
    process.execPath,
    [
      '-e',
      `const {spawn} = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(listener)}], {detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
child.on('message', message => process.send(message));`,
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  )
  const unrelated = spawn(process.execPath, ['-e', listener], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let orphan
  try {
    const [[child], [other]] = await Promise.all([once(root, 'message'), once(unrelated, 'message')])
    orphan = child.pid
    const snapshot = windowsDescendants(root.pid)
    assert(snapshot.some((item) => item.pid === orphan))
    const rootExited = once(root, 'exit')
    root.kill()
    await rootExited
    assert.equal(await listening(child.port), true)
    reapWindowsDescendants([...snapshot, { pid: other.pid, created: '2000-01-01T00:00:00.0000000Z' }])
    for (let i = 0; i < 40 && (await listening(child.port)); i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await listening(child.port), false, 'the captured child must release its port')
    assert.equal(await listening(other.port), true, 'unrelated/reused PIDs must not be killed')
  } finally {
    root.kill()
    unrelated.kill()
    if (orphan) {
      try {
        process.kill(orphan)
      } catch {}
    }
  }
})

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}
