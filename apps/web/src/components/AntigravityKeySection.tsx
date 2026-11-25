import { useCallback, useEffect, useState } from 'react'
import type { AntigravityKeyStatus } from '@vibemobile/protocol'
import { agentProfileErrorLabel } from '../lib/agentProfileErrors'
import { api } from '../lib/api'
import { Button } from './ui/button'
import { Input } from './ui/input'

export default function AntigravityKeySection({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState<AntigravityKeyStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setStatus(await api.antigravityKey())
    } catch (err) {
      setError(agentProfileErrorLabel(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(value: string | null) {
    if (busy || !status) return
    setBusy(true)
    setError('')
    try {
      setStatus(await api.setAntigravityKey(value))
      setKey('')
      onSaved()
    } catch (err) {
      setError(agentProfileErrorLabel(err))
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return error ? (
      <div className="space-y-2">
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
        <Button type="button" variant="outline" onClick={() => void load()}>
          重新读取
        </Button>
      </div>
    ) : (
      <p role="status" className="text-xs text-muted-foreground">
        读取配置中…
      </p>
    )
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (key.trim()) void save(key.trim())
      }}
    >
      <label htmlFor="antigravity-key" className="text-sm font-medium">
        Gemini API Key
      </label>
      <Input
        id="antigravity-key"
        type="password"
        autoComplete="new-password"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={2000}
        value={key}
        onChange={(event) => setKey(event.target.value)}
        disabled={busy}
        placeholder={status.hasApiKey ? '输入新密钥以更换' : '输入 Google AI Studio 密钥'}
        className="h-12 rounded-xl font-mono"
      />
      <p role="status" className="text-xs text-muted-foreground">
        {status.hasApiKey ? '密钥已保存在当前执行机。' : '当前使用执行机的 CLI 登录设置。'}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" className="min-h-11" disabled={busy || !key.trim()}>
          {busy ? '保存中…' : '保存密钥'}
        </Button>
        {status.hasApiKey && (
          <Button type="button" variant="ghost" className="min-h-11" disabled={busy} onClick={() => void save(null)}>
            移除密钥
          </Button>
        )}
      </div>
    </form>
  )
}
