import { useCallback, useEffect, useState } from 'react'
import type { AntigravityConnectionRequest, AntigravityKeyStatus } from '@vibemobile/protocol'
import { agentProfileErrorLabel } from '../lib/agentProfileErrors'
import { api } from '../lib/api'
import { Button } from './ui/button'
import { Input } from './ui/input'

export default function AntigravityKeySection({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState<AntigravityKeyStatus | null>(null)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const result = await api.antigravityKey()
      setStatus(result)
      setBaseUrl(result.baseUrl ?? '')
    } catch (err) {
      setError(agentProfileErrorLabel(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(value: AntigravityConnectionRequest) {
    if (busy || !status) return
    setBusy(true)
    setError('')
    try {
      const result = await api.setAntigravityKey(value)
      setStatus(result)
      setBaseUrl(result.baseUrl ?? '')
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

  const changed = Boolean(key.trim()) || baseUrl.trim() !== (status.baseUrl ?? '')

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed) void save({ baseUrl: baseUrl.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) })
      }}
    >
      <label htmlFor="antigravity-base-url" className="text-sm font-medium">
        Base URL
      </label>
      <Input
        id="antigravity-base-url"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={2048}
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        disabled={busy}
        placeholder="https://generativelanguage.googleapis.com"
        className="h-12 rounded-xl font-mono"
      />
      <p className="text-xs text-muted-foreground">填写 Gemini 兼容接口地址，留空使用 Google 官方接口。</p>
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
        placeholder={status.hasApiKey ? '输入新密钥以更换' : '输入 Gemini API Key'}
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
        <Button type="submit" className="min-h-11" disabled={busy || !changed}>
          {busy ? '保存中…' : '保存配置'}
        </Button>
        {status.hasApiKey && (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={busy}
            onClick={() => void save({ apiKey: null })}
          >
            恢复 CLI 登录
          </Button>
        )}
      </div>
    </form>
  )
}
