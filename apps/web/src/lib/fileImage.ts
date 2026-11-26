export function isRasterImage(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(path)
}

export function isSvgImage(path: string): boolean {
  return /\.svg$/i.test(path)
}

export function isImageFile(path: string): boolean {
  return isRasterImage(path) || isSvgImage(path)
}

export function isVideoFile(path: string): boolean {
  return /\.(?:mp4|m4v|webm|ogv|ogg|mov)$/i.test(path)
}

export function isNativeMedia(path: string): boolean {
  return isRasterImage(path) || isVideoFile(path)
}
