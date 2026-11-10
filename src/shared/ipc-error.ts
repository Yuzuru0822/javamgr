/**
 * IPC 结构化错误协议（shared，零依赖）。
 *
 * Electron ipcMain.handle 抛出的异常跨进程后只剩 message（自定义属性全部丢失，且会被
 * Electron 加上 "Error invoking remote method 'x': Error: " 前缀）。因此：
 * - 主进程（ipc-registry）：把结构化错误 JSON.stringify 后塞进 Error.message 再抛出；
 * - 渲染进程（api/ipc.ts）：从 rejection message 中还原出 {code, message, details}，
 *   重新抛出带 .code 的 Error，供 store / 组件做 ElMessage 提示与分支处理。
 * 校验失败、未找到、引用冲突、未实现等一律走此协议，不向渲染端抛裸异常。
 */

export type IpcErrorCode =
  /** zod 入参校验失败 */
  | 'VALIDATION_ERROR'
  /** 目标资源不存在（项目/JDK id 未命中） */
  | 'NOT_FOUND'
  /** 语义冲突（JDK 被引用禁止删除；运行中项目 confirm=false 拒绝删除） */
  | 'CONFLICT'
  /** 通道已注册但对应阶段（S2–S4）尚未实现 */
  | 'NOT_IMPLEMENTED'
  /** 服务层未预期异常 */
  | 'INTERNAL'

export interface StructuredIpcError {
  code: IpcErrorCode
  message: string
  details?: unknown
}

/** 主进程：编码为可穿越 IPC 的 Error.message 载荷 */
export function encodeIpcErrorPayload(error: StructuredIpcError): string {
  return JSON.stringify(error)
}

/**
 * 渲染进程：从 rejection message 还原结构化错误。
 * Electron 会包装 message 前缀，故取首个 '{' 到末个 '}' 的片段尝试解析；
 * 非 JSON（未走协议的错误）返回 null，由调用侧原样抛出。
 */
export function decodeIpcErrorPayload(message: string): StructuredIpcError | null {
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(message.slice(start, end + 1)) as Partial<StructuredIpcError>
    if (
      typeof parsed.code === 'string' &&
      typeof parsed.message === 'string' &&
      parsed.code.length > 0
    ) {
      return {
        code: parsed.code as IpcErrorCode,
        message: parsed.message,
        ...(parsed.details !== undefined ? { details: parsed.details } : {})
      }
    }
    return null
  } catch {
    return null
  }
}
