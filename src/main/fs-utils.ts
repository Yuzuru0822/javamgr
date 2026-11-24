import { rename } from 'node:fs/promises'

export type Sleep = (ms: number) => Promise<void>

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Windows 下 rename 可能被杀软/索引器瞬态锁住（EPERM/EACCES/EBUSY）：小退避重试。 */
export async function renameWithRetry(
  from: string,
  to: string,
  attempts = 3,
  sleep: Sleep = defaultSleep
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i === attempts - 1 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw err
      }
      await sleep(50)
    }
  }
}
