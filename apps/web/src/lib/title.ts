import { useEffect } from 'react'

const APP_NAME = 'VibeMobile'

/**
 * Set the browser tab title to what the page is showing.
 *
 * The route-level fallback lives in `App`; pages with real content (a chat
 * title, a file name) override it as soon as that content is known.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return
    document.title = `${title} · ${APP_NAME}`
  }, [title])
}

/** Fallback title for a route, with any `/r/<id>` prefix already stripped. */
export function routeTitle(pathname: string): string | null {
  if (pathname === '/') return '会话'
  if (pathname === '/settings') return '设置'
  if (pathname === '/files') return '文件'
  if (pathname === '/terminal') return '终端'
  if (pathname === '/login') return '登录'
  if (pathname.startsWith('/chat/')) return '对话'
  return null
}
