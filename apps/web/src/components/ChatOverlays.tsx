import type { ApprovalRequest } from '@vibemobile/protocol'
import type { FileRef } from '../lib/fileLink'
import ApprovalSheet from './ApprovalSheet'
import { UnifiedDiff } from './DiffView'
import FileViewer from './FileViewer'
import { Button } from './ui/button'

/** The overlays that sit above the chat: file viewer, approvals, diff. */
export default function ChatOverlays({
  openFile,
  onCloseFile,
  onOpenFile,
  readOnly,
  approvals,
  showDiff,
  diff,
  onCloseDiff,
}: {
  openFile: FileRef | null
  onCloseFile: () => void
  onOpenFile: (ref: FileRef) => void
  readOnly: boolean
  approvals: ApprovalRequest[]
  showDiff: boolean
  diff: string
  onCloseDiff: () => void
}) {
  return (
    <>
      {/* A link inside a rendered document opens the same way a link in the
          transcript does: same overlay, same place in the chat behind it. */}
      {openFile && <FileViewer file={openFile} onClose={onCloseFile} onOpenFile={onOpenFile} />}

      {!readOnly && approvals.map((approval) => <ApprovalSheet key={approval.requestId} approval={approval} />)}

      {showDiff && (
        <div className="fixed inset-0 z-40 flex flex-col bg-background">
          <header className="safe-top flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onCloseDiff}
              className="tap rounded-lg text-muted-foreground"
              aria-label="关闭"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="size-5"
              >
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </Button>
            <span className="text-[15px] text-foreground">本轮文件改动</span>
          </header>
          <div className="scroll-y min-h-0 flex-1">
            <UnifiedDiff diff={diff} />
          </div>
        </div>
      )}
    </>
  )
}
