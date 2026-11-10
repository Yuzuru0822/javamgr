import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { IpcEventChannel, IpcRequestChannel } from '../shared/ipc-channels'

/**
 * preload（S0）：contextBridge 暴露 window.api。
 * - invoke：Request/Response 泛型封装（通道名受 IpcRequestChannel 约束）
 * - on：事件订阅，返回取消订阅函数（通道名受 IpcEventChannel 约束）
 * 渲染进程零 Node 能力（contextIsolation: true），全部经此类型化通道。
 */

const api = {
  invoke: <T>(channel: IpcRequestChannel, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args),

  on: <T>(channel: IpcEventChannel, listener: (payload: T) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
