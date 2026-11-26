import { useEffect, useState } from 'react'

export const DESKTOP_MIN_WIDTH = 1024
const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`

function getInitialDesktop(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(DESKTOP_QUERY).matches
}

/**
 * Returns true when the viewport is wide enough for the desktop workbench
 * shell (`>= 1024px`). Falls back to `false` in test/headless environments
 * without `matchMedia`.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(getInitialDesktop)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(DESKTOP_QUERY)
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
    setIsDesktop(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return isDesktop
}
