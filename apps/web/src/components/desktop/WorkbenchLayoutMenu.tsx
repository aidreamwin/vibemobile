import {
  Bot,
  Check,
  ChevronDown,
  Columns2,
  Columns3,
  Columns4,
  FileCode2,
  LayoutGrid,
  PanelTop,
  PanelsTopLeft,
  Rows2,
  X,
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useWorkbenchStore, type PaneCount, type WorkbenchTab } from '../../lib/workbench'

const menuClass =
  'z-50 min-w-48 max-h-[min(65vh,440px)] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl'
const itemClass =
  'flex min-h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs outline-none data-[highlighted]:bg-secondary'

const layouts = [
  { count: 1, direction: 'auto', label: '单屏', icon: PanelTop },
  { count: 2, direction: 'horizontal', label: '左右分屏', icon: Columns2 },
  { count: 2, direction: 'vertical', label: '上下分屏', icon: Rows2 },
  { count: 3, direction: 'horizontal', label: '左右三分屏', icon: Columns3 },
  { count: 3, direction: 'auto', label: '三分屏', icon: PanelsTopLeft },
  { count: 4, direction: 'horizontal', label: '左右四分屏', icon: Columns4 },
  { count: 4, direction: 'auto', label: '四分屏', icon: LayoutGrid },
] as const

export function WorkbenchLayoutMenu({ container }: { container: HTMLElement | null }) {
  const count = useWorkbenchStore((s) => s.paneIds.length)
  const direction = useWorkbenchStore((s) => s.splitDirection)
  const settings = useWorkbenchStore((s) => s.activeTabId === 'settings')
  const setPaneCount = useWorkbenchStore((s) => s.setPaneCount)
  const LayoutIcon =
    direction === 'horizontal' && count === 3
      ? Columns3
      : direction === 'horizontal' && count === 4
        ? Columns4
        : count > 2
          ? LayoutGrid
          : direction === 'vertical' && count === 2
            ? Rows2
            : Columns2
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={settings}
          title="分屏布局（Ctrl+\\ 增加分屏）"
          aria-label="分屏布局"
          className="workbench-icon"
        >
          <LayoutIcon className="size-4" strokeWidth={1.7} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8} className={menuClass}>
          {layouts.map(({ count: size, direction: axis, label, icon: Icon }) => (
            <DropdownMenu.Item key={label} className={itemClass} onSelect={() => setPaneCount(size as PaneCount, axis)}>
              <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              <span className="flex-1">{label}</span>
              {count === size &&
                (size === 1 ||
                  direction === axis ||
                  (size === 2 && axis === 'horizontal' && direction === 'auto') ||
                  (size > 2 && axis === 'auto' && direction === 'vertical')) && <Check className="size-3.5" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function PaneContentMenu({
  index,
  tabs,
  current,
  container,
  onBrowse,
}: {
  index: number
  tabs: WorkbenchTab[]
  current: string | null
  container: HTMLElement | null
  onBrowse: (kind: 'agents' | 'files', index: number) => void
}) {
  const showTab = useWorkbenchStore((s) => s.showTabInPane)
  const focusPane = useWorkbenchStore((s) => s.focusPane)
  const closePane = useWorkbenchStore((s) => s.closePane)
  const count = useWorkbenchStore((s) => s.paneIds.length)
  const groups = [
    { name: 'Agent 会话', icon: Bot, items: tabs.filter((t) => t.kind === 'chat') },
    { name: '文件与改动', icon: FileCode2, items: tabs.filter((t) => t.kind === 'file' || t.kind === 'diff') },
  ]
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="切换分屏内容"
          aria-label={`切换分屏 ${index + 1} 内容`}
          className="workbench-icon shrink-0"
        >
          <ChevronDown className="size-4" strokeWidth={1.7} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content align="end" sideOffset={5} collisionPadding={8} className={`${menuClass} w-64`}>
          {groups.map(
            ({ name, icon: Icon, items }) =>
              items.length > 0 && (
                <DropdownMenu.Group key={name}>
                  <DropdownMenu.Label className="px-2.5 pt-2 pb-1 text-[11px] text-muted-foreground">
                    {name}
                  </DropdownMenu.Label>
                  {items.map((tab) => (
                    <DropdownMenu.Item
                      key={tab.id}
                      className={itemClass}
                      onSelect={() => showTab(index, tab.id)}
                      title={tab.title}
                    >
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                      {current === tab.id && <Check className="size-3.5 shrink-0" />}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Group>
              ),
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {(['agents', 'files'] as const).map((kind) => (
            <DropdownMenu.Item
              key={kind}
              className={itemClass}
              onSelect={() => {
                focusPane(index)
                onBrowse(kind, index)
              }}
            >
              {kind === 'agents' ? '选择其他会话' : '浏览其他文件'}
            </DropdownMenu.Item>
          ))}
          {count > 1 && (
            <DropdownMenu.Item className={itemClass} onSelect={() => closePane(index)}>
              <X className="size-3.5" />
              收起此分屏
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
