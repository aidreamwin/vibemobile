import { highlightFileRows } from './fileSyntax'

self.addEventListener('message', ({ data }: MessageEvent<{ id: number; path: string; text: string }>) => {
  const { id, path, text } = data
  const rows = highlightFileRows(path, text.split(/\r\n?|\n/))
  self.postMessage({ id, rows })
})
