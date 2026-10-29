import { useEffect, useState } from 'react'
import { socket, type ConnectionState } from '../lib/ws'

/**
 * The "the socket is down" strip, shared by every screen that can be on screen
 * while it is down.
 *
 * It has to be shared rather than left inside `BottomNav`, because `BottomNav`
 * is unmounted on `/chat/*` — and that is precisely the worst screen to be
 * wrong about: a chat page looking perfectly normal while nothing the agent
 * produces can reach it is the failure this exists to make visible. The two
 * mounts are independent on purpose: the strip lives in the layout on the list
 * screens and inside the chat header's own column, so it never has to know
 * where it is.
 */
export default function ConnectionBanner() {
  const [conn, setConn] = useState<ConnectionState>('closed')
  const [started, setStarted] = useState(false)

  // `onState` calls back immediately with the current state, which is why there
  // is no separate "read it once on mount" step here.
  useEffect(
    () =>
      socket.onState((state) => {
        setConn(state)
        // Read, not passed: `started` is about the socket, not about this
        // state change, and it can only ever go false -> true.
        setStarted(socket.started)
      }),
    [],
  )

  // Nothing before the app has even tried: `closed` is the socket's initial
  // value *and* what a dropped connection reports, so without this the first
  // paint of every page load — which happens one frame before `App` calls
  // `connect()` — would announce a disconnection that never happened.
  if (!started || conn === 'open') return null

  return (
    <div
      role="status"
      className="shrink-0 border-b border-warning/15 bg-warning/10 px-4 py-1.5 text-center text-[11px] font-medium text-warning"
    >
      {conn === 'connecting' ? '正在连接服务器…' : '连接已断开，正在重连…'}
    </div>
  )
}
