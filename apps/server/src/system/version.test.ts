import { describe, expect, it } from 'vitest'
import { compareVersions, updateAvailable } from './version.js'

const latest = (serverVersion: string, webVersion: string) => ({
  serverVersion,
  webVersion,
  commit: 'abc',
  createdAt: null,
  artifact: { role: 'hub' as const, file: 'x.tar.gz', sha256: 'a'.repeat(64), bytes: 1 },
})

const current = (serverVersion: string, webVersion: string | null) => ({
  serverVersion,
  webVersion,
  commit: 'def',
  dirty: false,
})

describe('compareVersions', () => {
  it('orders numeric segments', () => {
    expect(compareVersions('0.1.31', '0.1.30')).toBe(1)
    expect(compareVersions('0.1.30', '0.1.31')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('treats unparseable input as equal so a bad feed never offers a downgrade', () => {
    expect(compareVersions('latest', '1.0.0')).toBe(0)
  })
})

describe('updateAvailable', () => {
  it('offers a newer server to both roles', () => {
    expect(updateAvailable('hub', current('0.1.31', '0.1.57'), latest('0.1.32', '0.1.57'))).toBe(true)
    expect(updateAvailable('runner', current('0.1.31', '0.1.57'), latest('0.1.32', '0.1.57'))).toBe(true)
  })

  it('offers a web-only release only to the Hub', () => {
    expect(updateAvailable('hub', current('0.1.31', '0.1.57'), latest('0.1.31', '0.1.58'))).toBe(true)
    expect(updateAvailable('runner', current('0.1.31', '0.1.57'), latest('0.1.31', '0.1.58'))).toBe(false)
  })

  it('never offers the same or an older version', () => {
    expect(updateAvailable('hub', current('0.1.31', '0.1.57'), latest('0.1.31', '0.1.57'))).toBe(false)
    expect(updateAvailable('hub', current('0.1.31', '0.1.57'), latest('0.1.30', '0.1.99'))).toBe(false)
  })
})
