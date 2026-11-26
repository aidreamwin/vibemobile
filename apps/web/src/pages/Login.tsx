import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { api, ApiError } from '../lib/api'

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus()
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || pin.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.login(pin)
      onSuccess()
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('尝试次数过多，请稍后再试')
      } else if (err instanceof ApiError && err.status === 401) {
        setError('PIN 不正确')
        setPin('')
      } else {
        setError('登录失败，请检查服务器状态')
      }
      inputRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app-height safe-top safe-bottom scroll-y px-5">
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8">
        <div className="mb-8 text-center">
          <img
            src="/icon-192.png"
            alt=""
            width={64}
            height={64}
            className="mx-auto mb-5 size-16 rounded-2xl border border-border"
          />
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">VibeMobile</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">输入启动日志中的 PIN，连接你的开发机。</p>
        </div>

        <form onSubmit={submit} className="space-y-4 sm:rounded-2xl sm:border sm:border-border sm:bg-card/50 sm:p-6">
          <label htmlFor="login-pin" className="block text-sm font-medium text-foreground">
            连接 PIN
          </label>
          <Input
            ref={inputRef}
            id="login-pin"
            type="password"
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value)
              setError(null)
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'login-error' : undefined}
            placeholder="PIN"
            className="h-14 rounded-xl bg-secondary px-4 text-center text-xl tracking-[0.24em] md:text-xl dark:bg-secondary"
          />

          {error && (
            <p id="login-error" role="alert" className="text-sm leading-relaxed text-destructive">
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={busy || pin.length === 0}
            className="tap h-12 w-full rounded-xl text-[15px] font-medium"
          >
            {busy ? '验证中…' : '连接'}
          </Button>
        </form>
      </div>
    </main>
  )
}
