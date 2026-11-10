import path from 'node:path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * 测试分Profile（计划 §3 S3.7）：
 * - unit：纯 Node 单测（mock taskkill/tasklist/spawner）+ 渲染层组件测试
 *   （@vitest-environment happy-dom 文件级切换；Element Plus 真组件挂载）；
 * - integration：真实进程集成测试（现场编译 Loggy 夹具、真实 taskkill/tasklist/powershell），
 *   超时放宽（默认 120s）。
 * 运行：`npx vitest run tests/unit` 与 `npx vitest run tests/integration` 分开可跑；
 * `npm test` 跑全部（integration 需本机 D:\java17\jdk-17.0.12）。
 */

/** 渲染层 .vue 组件测试所需（vitest 3.2 projects 不继承根级 resolve/plugins，逐 project 注入） */
const rendererSupport = {
  plugins: [vue()] as never,
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer/src'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    // 文件级串行（phase4 架构验证建议-1）：集成测试 4 个文件并行会同时拉起约 10 个
    // JVM，弱内存环境下同时启动撞内存提交上限（与 runBatch 注释记录的 S6 现象同源）
    // 导致偶发失败（JVM 启动即败 → exitCode=1 类误报）。vitest 3.2 将 fileParallelism
    // 列为 NonProjectOptions（不能按 project 配置），只能置于根级——单测文件全量也
    // 随之串行（约 +10s，纯 Node mock 无资源压力，可接受）。
    fileParallelism: false,
    projects: [
      {
        ...rendererSupport,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts']
        }
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          teardownTimeout: 30_000
        }
      }
    ]
  }
})
