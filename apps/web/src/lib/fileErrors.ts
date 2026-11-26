import { ApiError } from './api'

export function fileReadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return '当前路径不在允许访问的工作区内。'
    if (error.status === 404) return '文件或目录不存在，可能已被移动或删除。'
    if (error.status === 415) return '此文件是暂不支持预览的二进制格式。'
    if (error.status === 413) return '文件超出了预览大小限制。'
    if (error.status >= 500) return '暂时无法读取文件，请稍后重试。'
  }
  return error instanceof Error ? error.message : '读取失败，请重试。'
}
