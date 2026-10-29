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
    inputRef.current?.focus()
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
      } else {
        setError('登录失败，请检查服务器状态')
      }
      setPin('')
      inputRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-height safe-top flex flex-col items-center justify-center gap-8 px-8">
      <div className="text-center">
        <div className="mb-3 text-3xl font-semibold tracking-tight text-foreground">VibeMobile</div>
        <p className="text-sm text-muted-foreground">输入启动日志中的 PIN 以连接到你的开发机</p>
      </div>

      <form onSubmit={submit} className="w-full max-w-xs space-y-4">
        {/* The oversized, letter-spaced PIN box is deliberate -- it is the only
            thing on this screen. Overriding the base takes all four: h-auto
            because `h-9` is a 36px strip next to 24px glyphs, `md:text-2xl`
            because the base drops to 14px at that breakpoint, and the `dark:`
            pair because a plain `bg-secondary` does not cancel
            `dark:bg-input/30`. */}
        <Input
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN"
          className="h-auto rounded-xl bg-secondary px-4 py-4 text-center text-2xl tracking-[0.4em] md:text-2xl dark:bg-secondary"
        />

        {error && <p className="text-center text-sm text-destructive">{error}</p>}

        <Button
          type="submit"
          disabled={busy || pin.length === 0}
          className="tap h-auto w-full py-3.5 text-[15px] font-medium"
        >
          {busy ? '验证中…' : '连接'}
        </Button>
      </form>
    </div>
  )
}
