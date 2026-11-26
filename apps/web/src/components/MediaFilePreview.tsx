import { useEffect, useRef, useState } from 'react'
import { Download, FileVideo, LoaderCircle } from 'lucide-react'
import { fileDownloadUrl, fileVideoUrl } from '../lib/api'
import { isVideoFile } from '../lib/fileImage'
import ImageFilePreview from './ImageFilePreview'

export function FileDownloadLink({ path, className }: { path: string; className: string }) {
  return (
    <a href={fileDownloadUrl(path)} download aria-label="下载文件" title="下载文件" className={className}>
      <Download aria-hidden="true" className="size-4" />
    </a>
  )
}

function VideoFilePreview({ path, visible, refresh }: { path: string; visible: boolean; refresh?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [revision, setRevision] = useState(() => (refresh ? Date.now() : undefined))
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!visible) ref.current?.pause()
  }, [visible])
  return (
    <section
      aria-label="视频预览"
      className="relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-black/30 p-3"
    >
      {failed ? (
        <div className="flex max-w-md flex-col items-center gap-3 text-center text-sm text-muted-foreground">
          <FileVideo className="size-9" strokeWidth={1.4} />
          <p role="alert">无法播放此视频。浏览器可能不支持该编码，或文件读取失败。</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className="rounded-lg border px-3 py-2 text-foreground"
              onClick={() => {
                setFailed(false)
                setReady(false)
                setRevision(Date.now())
              }}
            >
              重试
            </button>
            <a href={fileDownloadUrl(path)} download className="rounded-lg border px-3 py-2 text-foreground">
              下载文件
            </a>
          </div>
        </div>
      ) : (
        <>
          {!ready && (
            <span
              role="status"
              className="pointer-events-none absolute inset-0 grid place-content-center text-xs text-muted-foreground"
            >
              <LoaderCircle className="mx-auto mb-2 size-5 animate-spin" />
              正在读取视频…
            </span>
          )}
          {/* Native controls expose the browser's playback and seeking support. */}
          {/* biome-ignore lint/a11y/useMediaCaption: Local files may not contain captions; the browser supplies its native track controls. */}
          <video
            ref={ref}
            key={revision}
            controls
            playsInline
            preload={visible ? 'metadata' : 'none'}
            src={fileVideoUrl(path, revision)}
            onLoadedMetadata={() => setReady(true)}
            onError={() => setFailed(true)}
            className="max-h-full w-full max-w-full rounded-md object-contain"
          />
        </>
      )}
    </section>
  )
}

export default function MediaFilePreview({
  path,
  refresh,
  desktop,
  visible = true,
}: {
  path: string
  refresh?: boolean
  desktop?: boolean
  visible?: boolean
}) {
  return isVideoFile(path) ? (
    <VideoFilePreview path={path} refresh={refresh} visible={visible} />
  ) : (
    <ImageFilePreview path={path} refresh={refresh} desktop={desktop} />
  )
}
