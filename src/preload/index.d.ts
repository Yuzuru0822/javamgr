import type { IpcEventChannel, IpcRequestChannel } from '../shared/ipc-channels'

/** 渲染进程全局 window.api 类型（实现见 src/preload/index.ts；仅类型，不引入 electron 类型面） */
declare global {
  interface Window {
    api: {
      /** invoke 请求（通道名受 IpcRequestChannel 约束）；返回值类型由调用侧泛型指定 */
      invoke: <T = unknown>(channel: IpcRequestChannel, ...args: unknown[]) => Promise<T>
      /** 事件订阅（通道名受 IpcEventChannel 约束）；返回取消订阅函数 */
      on: <T = unknown>(channel: IpcEventChannel, listener: (payload: T) => void) => () => void
    }
  }
}

export {}
