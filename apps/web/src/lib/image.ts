/**
 * Client-side image preparation.
 *
 * Codex rejects remote image URLs outright ("remote image URLs are not
 * supported; use an inline data URL instead"), so anything we send must be a
 * data URL. Phone cameras produce 4-8 MB JPEGs, and base64 inflates that by
 * ~33% — well past what is sensible to push through a WebSocket from a phone
 * on WiFi. So we downscale and re-encode first.
 */

/** Long edge cap. Anthropic-style vision models are trained around this. */
const MAX_EDGE = 1568
/** Target ceiling for the encoded payload. */
const MAX_BYTES = 1_500_000

/**
 * How many pictures one message may carry.
 *
 * A second copy of `MAX_PER_MESSAGE` in `apps/server/src/images/store.ts`, and
 * the duplication is deliberate: `packages/protocol` is types-only, so there is
 * no module both halves can import a value from. The server keeps its own copy
 * because a hand-written WebSocket frame never went through this file — this
 * one exists so the user is told *before* they type a caption for a ninth
 * picture, not to make the server's check unnecessary.
 */
export const MAX_IMAGES = 8

export interface PreparedImage {
  dataUrl: string
  width: number
  height: number
  bytes: number
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件')
  }

  const bitmap = await loadBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 canvas')

  // JPEG has no alpha; fill white so transparent PNGs do not turn black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  if ('close' in bitmap) bitmap.close()

  // Step the quality down until the payload fits.
  let quality = 0.8
  let dataUrl = canvas.toDataURL('image/jpeg', quality)
  while (approxBytes(dataUrl) > MAX_BYTES && quality > 0.35) {
    quality -= 0.15
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }

  return { dataUrl, width, height, bytes: approxBytes(dataUrl) }
}

function approxBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return Math.floor((base64.length * 3) / 4)
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file)
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('图片解码失败'))
      img.src = url
    })
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}
