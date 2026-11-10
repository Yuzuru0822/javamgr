/**
 * 退出策略执行（计划 §2.3-A / §3 S3.4，风险 R5 缓解）。
 *
 * - keep（默认）：退出不动子进程（spawn 即 detached+unref，天然分离）；
 *   仅把 runs.json 落盘，供下次启动重识别（A13 状态连续性）。
 * - stopAll：退出前逐项目 taskkill 杀树（单项 8s 超时，Promise.allSettled 并行），
 *   单项失败不阻塞其余（失败记日志，退出继续）。
 *
 * 使用：app 'before-quit' 中 event.preventDefault() → await prepareExit(...) → app.quit()
 * （Electron before-quit 同步事件无法 await，须拆两段式，见 index.ts 装配）。
 */

import type { Settings } from '../shared/types'
import type { ProcessManager } from './process/process-manager'

export interface ExitOutcome {
  policy: 'keep' | 'stopAll'
  /** stopAll 策略下尝试终止的项目数 */
  attempted: number
  /** stopAll 策略下终止失败的项目 id（keep 策略恒空） */
  failed: string[]
}

/** 执行退出策略：stopAll 并行杀树 → 统一 runs.json 落盘。绝不让异常阻断退出。 */
export async function prepareExit(
  settings: Settings,
  processManager: ProcessManager
): Promise<ExitOutcome> {
  let attempted: string[] = []
  const failed: string[] = []
  if (settings.exitPolicy === 'stopAll') {
    try {
      attempted = await processManager.killAllForExit()
      // killAllForExit 内部已把失败项目落 note；此处汇总失败清单供日志呈现
      for (const state of processManager.listRuntimeStates()) {
        if (state.note?.startsWith('退出时终止失败')) failed.push(state.projectId)
      }
    } catch (err) {
      console.error('[lifecycle] 退出全停执行异常（继续退出）：', err)
    }
  }
  try {
    await processManager.prepareForExit() // 停轮询 + runs.json 落盘
  } catch (err) {
    console.error('[lifecycle] runs.json 落盘失败（继续退出）：', err)
  }
  return { policy: settings.exitPolicy, attempted: attempted.length, failed }
}
