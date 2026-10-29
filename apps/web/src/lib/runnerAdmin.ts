/** Helpers shared by the settings-page runner manager. */
import { ApiError } from './api'

/** The two variables a remote runner needs, copied as one block. */
export function runnerEnvBlock(id: string, token: string): string {
  return `VIBEMOBILE_RUNNER_ID=${id}\nVIBEMOBILE_RUNNER_TOKEN=${token}`
}

const ERROR_TEXT: Record<string, string> = {
  invalid_runner_name: '名称不能为空，且不超过 100 个字符。',
  runner_limit: '执行机数量已达上限（200）。',
  runner_not_found: '该执行机不存在，可能已被删除。',
  runner_default: '默认执行机不能删除。',
  runner_store_unwritable: '无法写入执行机名单，请检查 Hub 的名单文件是否可写。',
  runner_id_conflict: '生成执行机 ID 失败，请重试。',
}

/** Stable server codes are translated; anything else falls back to its message. */
export function runnerAdminError(error: unknown): string {
  if (error instanceof ApiError) return ERROR_TEXT[error.code ?? ''] ?? error.message
  return error instanceof Error ? error.message : String(error)
}
