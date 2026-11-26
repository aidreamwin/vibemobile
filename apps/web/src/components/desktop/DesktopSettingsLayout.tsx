import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, CircleArrowUp, FolderOpen, Info, Monitor, PanelsTopLeft, Server, ShieldCheck } from 'lucide-react'
import { Tabs } from 'radix-ui'

export const settingsSections = {
  agents: { label: '代理', icon: Bot },
  workbench: { label: '工作台', icon: PanelsTopLeft },
  workspace: { label: '工作区', icon: FolderOpen },
  runners: { label: '远程执行机', icon: Monitor },
  updates: { label: '更新', icon: CircleArrowUp },
  system: { label: '系统', icon: Server },
  security: { label: '安全', icon: ShieldCheck },
  about: { label: '关于', icon: Info },
}

export type SettingsSectionId = keyof typeof settingsSections

const DesktopSettingsContext = createContext<SettingsSectionId | null>(null)

export function useDesktopSettings() {
  return useContext(DesktopSettingsContext) !== null
}

const SIDE_NAV_MIN_WIDTH = 600

export default function DesktopSettingsLayout({
  hub,
  section,
  onSectionChange,
  children,
}: {
  hub: boolean
  section: SettingsSectionId
  onSectionChange: (section: SettingsSectionId) => void
  children: ReactNode
}) {
  const [vertical, setVertical] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const resize = () => setVertical(element.clientWidth >= SIDE_NAV_MIN_WIDTH)
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    navigation.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [section, vertical])

  return (
    <DesktopSettingsContext.Provider value={section}>
      <Tabs.Root
        ref={root}
        value={section}
        onValueChange={(value) => onSectionChange(value as SettingsSectionId)}
        orientation={vertical ? 'vertical' : 'horizontal'}
        aria-label="设置"
        className={`flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background ${vertical ? '' : 'flex-col'}`}
      >
        <Tabs.List
          ref={navigation}
          aria-label="设置分类"
          className={`flex shrink-0 gap-1 border-border bg-card/35 ${
            vertical
              ? 'scroll-y w-44 flex-col border-r px-2.5 py-4'
              : 'scroll-x items-center border-b px-2 py-1.5 [scrollbar-width:none]'
          }`}
        >
          {Object.entries(settingsSections).map(([id, { label, icon: Icon }]) =>
            id === 'runners' && !hub ? null : (
              <Tabs.Trigger
                key={id}
                value={id}
                className="relative flex h-8 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-[state=active]:bg-primary/12 data-[state=active]:text-primary"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
                {label}
              </Tabs.Trigger>
            ),
          )}
        </Tabs.List>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </Tabs.Root>
    </DesktopSettingsContext.Provider>
  )
}

export function DesktopSettingsSection({ section, children }: { section: SettingsSectionId; children: ReactNode }) {
  const { label } = settingsSections[section]
  const selected = useContext(DesktopSettingsContext) === section
  const content = useRef<HTMLDivElement>(null)
  const scrollPosition = useRef(0)

  useLayoutEffect(() => {
    if (selected && content.current) content.current.scrollTop = scrollPosition.current
  }, [selected])

  return (
    <Tabs.Content
      ref={content}
      value={section}
      onScroll={(event) => {
        if (selected) scrollPosition.current = event.currentTarget.scrollTop
      }}
      className="scroll-y @container h-full min-w-0 flex-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <div className="max-w-[46rem] px-4 py-5 @min-[500px]:px-8 @min-[500px]:py-7">
        <section aria-label={label}>
          <h2 className="mb-4 text-lg leading-tight font-semibold tracking-tight text-foreground @min-[500px]:text-xl">
            {label}
          </h2>
          <div className="overflow-hidden divide-y divide-border/70 rounded-lg border border-border bg-card/45">
            {children}
          </div>
        </section>
      </div>
    </Tabs.Content>
  )
}
