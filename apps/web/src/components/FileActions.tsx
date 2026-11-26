import { useState, type ReactElement } from 'react'
import { ContextMenu, Dialog, DropdownMenu } from 'radix-ui'
import { Copy, Download, Ellipsis, Pencil, Trash2 } from 'lucide-react'
import type { FileEntry } from '@vibemobile/protocol'
import { api, ApiError, fileDownloadUrl } from '../lib/api'
import { hasFileEdits, invalidateDirectorySnapshot, invalidateFileSnapshot } from '../lib/fileSnapshots'
import { filePathKey } from '../lib/fileLink'
import { parentPath } from '../lib/workspace'
import { useWorkbenchStore } from '../lib/workbench'
import { createPortal } from 'react-dom'

const menuClass = 'z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-foreground shadow-xl'
const itemClass =
  'flex min-h-8 cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs outline-none data-[highlighted]:bg-accent'

function relativePath(root: string, path: string) {
  const base = filePathKey(root).replace(/\/+$/, '')
  const normalized = filePathKey(path)
  return normalized.startsWith(base + '/')
    ? path.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').replace(/\/+$/, '').length + 1)
    : path
}

async function copyText(value: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      /* fall back on LAN HTTP */
    }
  }
  const field = document.createElement('textarea')
  field.value = value
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  try {
    if (!document.execCommand('copy')) throw new Error('复制失败')
  } finally {
    field.remove()
  }
}

export default function FileActions({
  entry,
  root,
  onChanged,
  children,
  mobile = false,
}: {
  entry: FileEntry
  root: string
  onChanged: (entry?: FileEntry) => void
  children?: ReactElement
  mobile?: boolean
}) {
  const [operation, setOperation] = useState<'rename' | 'delete' | null>(null)
  const [name, setName] = useState(entry.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const Menu = mobile ? DropdownMenu : ContextMenu
  function ask(action: 'rename' | 'delete') {
    setError('')
    setName(entry.name)
    setOperation(action)
  }
  async function perform() {
    if (!operation || busy) return
    if (hasFileEdits(entry.path)) {
      setError('文件有未保存的修改或正在保存，请先完成编辑。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const replacement =
        operation === 'rename' ? await api.renameFile(entry.path, name) : (await api.deleteFile(entry.path), undefined)
      invalidateFileSnapshot(entry.path)
      if (replacement) invalidateFileSnapshot(replacement.path)
      invalidateDirectorySnapshot(parentPath(entry.path))
      useWorkbenchStore.getState().fileChanged(entry.path, replacement)
      setOperation(null)
      onChanged(replacement)
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? '该名称已存在，请使用其他名称。'
          : err instanceof Error
            ? err.message
            : '文件操作失败',
      )
    } finally {
      setBusy(false)
    }
  }
  function copy(value: string) {
    void copyText(value).then(
      () => setNotice('已复制路径'),
      () => setNotice('复制失败，请重试'),
    )
  }
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          {mobile ? (
            <button
              type="button"
              aria-label={`${entry.name} 的文件操作`}
              className="tap shrink-0 rounded-lg text-muted-foreground"
            >
              <Ellipsis className="size-5" />
            </button>
          ) : (
            children
          )}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content collisionPadding={8} className={menuClass} aria-label="文件操作">
            <Menu.Item asChild className={itemClass}>
              <a href={fileDownloadUrl(entry.path)} download>
                <Download className="size-3.5" />
                下载
              </a>
            </Menu.Item>
            <Menu.Item className={itemClass} onSelect={() => ask('rename')}>
              <Pencil className="size-3.5" />
              更名
            </Menu.Item>
            <Menu.Item className={itemClass} onSelect={() => copy(relativePath(root, entry.path))}>
              <Copy className="size-3.5" />
              复制相对路径
            </Menu.Item>
            <Menu.Item className={itemClass} onSelect={() => copy(entry.path)}>
              <Copy className="size-3.5" />
              复制绝对路径
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Item className={itemClass + ' text-destructive'} onSelect={() => ask('delete')}>
              <Trash2 className="size-3.5" />
              删除
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <Dialog.Root
        open={operation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setOperation(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/55" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 z-[81] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 text-foreground shadow-2xl"
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault()
            }}
            onPointerDownOutside={(event) => event.preventDefault()}
          >
            <Dialog.Title className="text-base font-semibold">
              {operation === 'delete' ? '确认删除文件？' : '更名文件'}
            </Dialog.Title>
            <Dialog.Description className="mt-2 break-all text-sm text-muted-foreground">
              {operation === 'delete' ? '此文件将被永久删除，操作无法撤销。' : '请输入新的文件名。'}
              <span className="mt-2 block font-mono text-xs">{entry.path}</span>
            </Dialog.Description>
            {operation === 'rename' && (
              <input
                aria-label="新文件名"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
                className="mt-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOperation(null)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || (operation === 'rename' && (!name.trim() || name === entry.name))}
                onClick={() => void perform()}
                className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${operation === 'delete' ? 'bg-destructive text-background' : 'bg-primary text-primary-foreground'}`}
              >
                {busy ? '处理中…' : operation === 'delete' ? '确认删除' : '确认更名'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {notice &&
        createPortal(
          <button
            type="button"
            onClick={() => setNotice('')}
            className="fixed bottom-12 left-1/2 z-[90] -translate-x-1/2 rounded-lg border bg-popover px-4 py-2 text-sm shadow-lg"
          >
            <span role="status">{notice}</span> · 关闭
          </button>,
          document.body,
        )}
    </>
  )
}
