import { NavLink } from 'react-router-dom'
import { FolderOpen, MessagesSquare, Settings, Terminal } from 'lucide-react'
import ConnectionBanner from './ConnectionBanner'

const TABS = [
  { to: '/', label: '会话', icon: MessagesSquare },
  { to: '/files', label: '文件', icon: FolderOpen },
  { to: '/terminal', label: '终端', icon: Terminal },
  { to: '/settings', label: '设置', icon: Settings },
]

export default function BottomNav() {
  return (
    <nav aria-label="主导航" className="safe-bottom shrink-0 border-t border-border bg-background/95 backdrop-blur-xl">
      <ConnectionBanner />
      <div className="flex h-14 items-stretch justify-around px-1">
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `tap relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
                isActive ? 'font-semibold text-primary' : 'text-muted-foreground active:text-foreground/90'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`flex h-7 w-12 items-center justify-center rounded-xl ${isActive ? 'bg-secondary' : ''}`}
                >
                  <Icon aria-hidden="true" className="size-5" strokeWidth={isActive ? 2 : 1.75} />
                </span>
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
