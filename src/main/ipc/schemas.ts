/**
 * IPC 入参 zod schema（§2.5 全表）。
 * ipc-registry 在每个通道 handler 入口做校验；strict() 拒绝未知键（抓客户端字段拼写错误），
 * 校验失败返回结构化 VALIDATION_ERROR，不向渲染端抛裸异常。
 */

import { z } from 'zod'

const encodingOverrideSchema = z.enum(['auto', 'utf8', 'gbk'])

/** projects:create（ProjectInput；id 由主进程生成，请求体携带即拒绝） */
export const projectCreateSchema = z
  .object({
    name: z.string().min(1, '项目名称不能为空'),
    jarPath: z.string().min(1, 'jar 路径不能为空'),
    jdkId: z.string().min(1, '必须绑定 JDK'),
    jvmArgs: z.array(z.string()),
    programArgs: z.array(z.string()),
    envVars: z.record(z.string(), z.string()),
    logFilePath: z.string().min(1).optional(),
    encodingOverride: encodingOverrideSchema.optional()
  })
  .strict()

/** projects:update（必须携带 id） */
export const projectUpdateSchema = projectCreateSchema.extend({
  id: z.string().min(1, '缺少项目 id')
})

/** projects:scanJars（2026-11-10 扫描导入：指定目录递归收集 *.jar） */
export const scanJarsSchema = z
  .object({
    rootDir: z.string().min(1, '扫描目录不能为空')
  })
  .strict()

/** projects:delete（运行中且 confirm=false 拒绝；confirm=true 先 stop 再删，S3 起生效） */
export const projectDeleteSchema = z
  .object({
    id: z.string().min(1, '缺少项目 id'),
    confirm: z.boolean()
  })
  .strict()

/** projects:start / stop / restart */
export const projectIdSchema = z
  .object({
    id: z.string().min(1, '缺少项目 id')
  })
  .strict()

/**
 * jdk:add（S2：手动添加只需路径，版本/发行方由主进程 validateJdkPath 派生——
 * 单一权威源在主进程，渲染端不传自报的 version/vendor；name 可选覆盖派生展示名）
 */
export const jdkAddSchema = z
  .object({
    homePath: z.string().min(1, 'JDK 路径不能为空'),
    name: z.string().min(1, 'JDK 名称不能为空').optional()
  })
  .strict()

/** jdk:update（必须携带 id；路径变更时主进程重新校验派生） */
export const jdkUpdateSchema = jdkAddSchema.extend({
  id: z.string().min(1, '缺少 JDK id')
})

/** jdk:validate（S2：即时校验，不入库） */
export const jdkValidateSchema = z
  .object({
    homePath: z.string().min(1, 'JDK 路径不能为空')
  })
  .strict()

/** jdk:remove */
export const jdkRemoveSchema = z
  .object({
    id: z.string().min(1, '缺少 JDK id')
  })
  .strict()

/** settings:set（局部合并：至少允许空对象做幂等 no-op；键约束见 §2.4） */
export const settingsSetSchema = z
  .object({
    mcpEnabled: z.boolean().optional(),
    mcpPort: z.number().int().min(1).max(65535, '端口范围 1–65535').optional(),
    exitPolicy: z.enum(['keep', 'stopAll']).optional(),
    startupGraceSeconds: z.number().int().min(1).max(600).optional(),
    /** 计划 §2.3-A：重识别存活轮询间隔可配 5–10s */
    pollIntervalSeconds: z.number().int().min(5).max(10).optional(),
    tailInitialLines: z.number().int().min(1).max(10000).optional(),
    logMaxFileMb: z.number().int().min(1).max(1024).optional(),
    logMaxRotations: z.number().int().min(1).max(10).optional(),
    logRunsToKeep: z.number().int().min(1).max(100).optional(),
    scanRoots: z.array(z.string().min(1)).optional(),
    closeToTray: z.boolean().optional(),
    /** v0.5.0 浏览器面板 */
    webEnabled: z.boolean().optional(),
    webPort: z.number().int().min(1).max(65535, '端口范围 1–65535').optional()
  })
  .strict()

/** logs:readHistory（source 与 MCP read_logs 对齐） */
export const readHistorySchema = z
  .object({
    projectId: z.string().min(1, '缺少 projectId'),
    lines: z.number().int().min(1).max(10000).optional(),
    source: z.enum(['auto', 'file', 'stdout']).optional()
  })
  .strict()

/** logs:search（SearchParams，§2.5/§2.6 对齐） */
export const searchSchema = z
  .object({
    projectId: z.string().min(1, '缺少 projectId'),
    keyword: z.string().optional(),
    level: z.enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']).optional(),
    startTime: z.string().min(1).optional(),
    endTime: z.string().min(1).optional(),
    maxResults: z.number().int().min(1).max(10000).optional(),
    contextLines: z.number().int().min(0).max(50).optional()
  })
  .strict()

/** app:pickFile（S3：ProjectForm jar 路径文件选择器；filters 同 dialog.showOpenDialog；directory=true 选目录，扫描导入用） */
export const pickFileSchema = z
  .object({
    title: z.string().min(1).optional(),
    directory: z.boolean().optional(),
    filters: z
      .array(
        z
          .object({
            name: z.string().min(1),
            extensions: z.array(z.string().min(1))
          })
          .strict()
      )
      .optional()
  })
  .strict()
