export function isRasterImage(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(path)
}

export function isSvgImage(path: string): boolean {
  return /\.svg$/i.test(path)
}

export function isImageFile(path: string): boolean {
  return isRasterImage(path) || isSvgImage(path)
}
