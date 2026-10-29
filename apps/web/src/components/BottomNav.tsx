import { NavLink } from 'react-router-dom'
import ConnectionBanner from './ConnectionBanner'

const TABS = [
  { to: '/', label: '会话', icon: 'M4 5h16M4 12h16M4 19h10' },
  { to: '/files', label: '文件', icon: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z' },
  { to: '/terminal', label: '终端', icon: 'M4 6l5 6-5 6M12 18h8' },
  {
    to: '/settings',
    label: '设置',
    icon: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a7.7 7.7 0 000-6l2-1.5-2-3.4-2.4 1a7.7 7.7 0 00-5.2-1L9.4 1 7 4.4l2 1.5a7.7 7.7 0 000 6l-2 1.5L9.4 23l2.4-1a7.7 7.7 0 005.2-1l2.4 1 2-3.4z',
  },
]

export default function BottomNav() {
  return (
    <nav className="safe-bottom shrink-0 border-t border-border bg-background/95 backdrop-blur-xl">
      <ConnectionBanner />
      <div className="flex h-14 items-stretch justify-around px-1">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) =>
              `tap relative flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-all ${
                isActive ? 'font-semibold text-primary' : 'text-muted-foreground active:text-foreground/90'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                >
                  <path d={tab.icon} />
                </svg>
                <span>{tab.label}</span>
                {isActive && <span className="absolute bottom-1 h-0.5 w-5 rounded-full bg-primary" />}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
