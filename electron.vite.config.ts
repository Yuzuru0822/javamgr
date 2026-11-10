import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * electron-vite 三段式构建（§2.1）：
 * - main/preload：dependencies（@modelcontextprotocol/sdk / iconv-lite / zod）保持 external，
 *   运行时从 node_modules require；src/shared 为仓内相对导入，直接打包进产物。
 * - renderer：@renderer / @shared 别名与 tsconfig.web.json paths 保持一致。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()]
  }
})
