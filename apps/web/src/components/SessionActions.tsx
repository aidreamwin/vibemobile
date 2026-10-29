import { useState } from 'react'
import type { SessionSummary } from '@vibemobile/protocol'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { api } from '../lib/api'
import Sheet from './Sheet'

type Mode = 'menu' | 'rename' | 'confirmDelete'

export default function SessionActions({
  session,
  onClose,
  onRename,
  onDelete,
  onArchived,
  onPinned,
}: {
  session: SessionSummary
  onClose: () => void
  onRename: (name: string) => void
  onDelete: () => void
  /**
   * Reported AFTER the server accepted it, so the list never shows a state the
   * backend does not have. The request itself is made here rather than by the
   * caller because a failure has to keep this sheet open with the reason on it —
   * closing optimistically and showing a banner on the page underneath is how a
   * failed archive comes to look like it worked.
   */
  onArchived: (archived: boolean) => void
  onPinned: (pinned: boolean) => void
}) {
  const [mode, setMode] = useState<Mode>('menu')
  const [name, setName] = useState(session.title)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const archived = session.archived === true
  const pinned = session.pinned === true

  async function toggleArchive() {
    setBusy(true)
    setError(null)
    try {
      await api.archiveSession(session.id, !archived)
      // Only after the await: this is what closes the sheet, and closing it
      // first would take the error message away with it.
      onArchived(!archived)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function togglePin() {
    setBusy(true)
    setError(null)
    try {
      await api.pinSession(session.id, !pinned)
      onPinned(!pinned)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'rename') {
    return (
      <Sheet title="重命名会话" onClose={onClose}>
        <div className="space-y-3 px-4 pt-2 pb-4">
          {/* h-auto: the base is h-9, which is under the 44px touch target the
              rest of this screen keeps. py-2.5 on 16px text lands on 44px. */}
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-auto py-2.5" />
          {error && <div className="text-[12px] text-destructive">{error}</div>}
          <Button
            onClick={() => name.trim() && onRename(name.trim())}
            disabled={!name.trim() || name.trim() === session.title}
            className="tap h-auto w-full py-3 text-[15px]"
          >
            保存
          </Button>
        </div>
      </Sheet>
    )
  }

  if (mode === 'confirmDelete') {
    // Deleting a thread is irreversible on both providers — the transcript is
    // gone with no undo — so this sheet is not dismissable by tapping outside.
    //
    // Stays a Sheet rather than becoming ui/alert-dialog: the whole reason this
    // app draws bottom sheets is that a centred dialog puts its buttons at the
    // top of a phone, out of thumb reach (see the note in Sheet.tsx). Radix's
    // Dialog already gives us the focus trap and scroll lock an AlertDialog
    // would have added on top.
    return (
      <Sheet onClose={onClose} dismissable={false}>
        <div className="space-y-3 px-4 pt-3 pb-4">
          <h2 className="text-base font-medium text-foreground">删除这个会话？</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            「{session.title || '未命名会话'}」的对话记录会被永久删除，
            <span className="text-foreground/90">无法恢复</span>。工作目录里的文件不受影响。
          </p>
          {error && <div className="text-[12px] text-destructive">{error}</div>}
          <Button variant="destructive" onClick={onDelete} className="tap h-auto w-full py-3 text-[15px]">
            确认删除
          </Button>
          <Button variant="secondary" onClick={onClose} className="tap h-auto w-full py-3 text-[15px]">
            取消
          </Button>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet onClose={onClose}>
      <div className="px-4 pt-2 pb-4">
        <div className="mb-3 truncate text-[13px] text-muted-foreground">{session.title || '未命名会话'}</div>
        {error && <div className="mb-2 text-[12px] text-destructive">{error}</div>}
        <div className="space-y-2">
          <Action disabled={busy} onClick={() => setMode('rename')}>
            重命名
          </Action>
          {/* Labelled with what it will do, not with what the session is. The
              two states are only distinguishable here if the row says so, and a
              session in the archive is exactly where 归档 would be a dead end:
              it was already archived, so tapping it again did nothing visible. */}
          <Action disabled={busy} onClick={toggleArchive}>
            {archived ? '取消归档（回到列表）' : '归档（从列表隐藏，记录保留）'}
          </Action>
          <Action disabled={busy} onClick={togglePin}>
            {pinned ? '取消置顶' : '置顶（排在最前）'}
          </Action>
          <Action variant="destructive" disabled={busy} onClick={() => setMode('confirmDelete')}>
            删除会话
          </Action>
          <Action disabled={busy} onClick={onClose}>
            取消
          </Action>
        </div>
      </div>
    </Sheet>
  )
}

/** One row in the actions sheet -- was four copies of the same class string. */
function Action({
  onClick,
  variant = 'secondary',
  disabled = false,
  children,
}: {
  onClick: () => void
  variant?: 'secondary' | 'destructive'
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Button variant={variant} onClick={onClick} disabled={disabled} className="tap h-auto w-full py-3 text-[15px]">
      {children}
    </Button>
  )
}
