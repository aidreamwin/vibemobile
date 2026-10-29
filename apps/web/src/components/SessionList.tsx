import type { SessionSummary } from '@vibemobile/protocol'
import SessionRow from './SessionRow'

export default function SessionList({
  sessions,
  providerName,
  onOpen,
  onActions,
}: {
  sessions: SessionSummary[]
  providerName: (id: string) => string
  onOpen: (session: SessionSummary) => void
  onActions: (session: SessionSummary) => void
}) {
  return (
    <ul className="divide-y divide-border">
      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          providerName={providerName}
          onOpen={() => onOpen(session)}
          onActions={() => onActions(session)}
        />
      ))}
    </ul>
  )
}
