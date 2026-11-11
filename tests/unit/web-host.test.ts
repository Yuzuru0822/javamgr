import { get as httpGet, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebHost } from '../../src/main/web/web-host'
import type { IpcCallFn } from '../../src/main/web/web-host'

/**
 * WebHost 单测（v0.5.0 浏览器面板）：真实 node:http + 临时静态根 + fake IPC 透传——
 * 静态服务 / IPC 透传（成功/域错误/内容类型）/ SSE 事件流 / 安全防护
 * （Host 字面量防 DNS 重绑定、Origin 同源防 CSRF、目录穿越、未知通道）。
 * Node 内置 fetch 直连（监听 127.0.0.1:0 内核分配端口）。
 */

let rootDir: string
let host: WebHost
let baseUrl: string
const callLog: Array<{ channel: string; raw: unknown }> = []

const fakeCall: IpcCallFn = async (channel, raw) => {
  callLog.push({ channel, raw })
  if (channel === 'projects:list') return { ok: true, data: [{ id: 'p1', name: 'demo' }] }
  if (channel === 'projects:boom') {
    return { ok: false, code: 'VALIDATION_ERROR', message: '参数校验失败' }
  }
  if (channel === 'crash:internal') return { ok: false, code: 'INTERNAL', message: '内部错误' }
  return { ok: true, data: null }
}

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'web-host-'))
  await mkdir(path.join(rootDir, 'assets'), { recursive: true })
  await writeFile(path.join(rootDir, 'index.html'), '<html>panel</html>')
  await writeFile(path.join(rootDir, 'assets', 'app.js'), 'console.log(1)')
  host = new WebHost({ rootDir, getPort: () => 0, isEnabled: () => true, call: fakeCall })
  const status = await host.start()
  baseUrl = status.url ?? ''
  expect(status.enabled).toBe(true)
})

afterAll(async () => {
  await host.stop()
  await rm(rootDir, { recursive: true, force: true })
})

describe('web/host：静态服务（同一渲染端构建产物）', () => {
  it('GET / → index.html（text/html）', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('panel')
  })

  it('GET /assets/app.js → 正确 MIME；未知路径 404', async () => {
    const js = await fetch(`${baseUrl}/assets/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    const missing = await fetch(`${baseUrl}/nope.js`)
    expect(missing.status).toBe(404)
  })

  it('目录穿越（%2e%2e 越出根）被拒', async () => {
    const res = await fetch(`${baseUrl}/assets/..%2f..%2fsecret.txt`)
    expect([403, 404]).toContain(res.status)
  })
})

describe('web/host：IPC 透传（与 ipcMain 同组 handler 的出口）', () => {
  it('POST /web/api/projects:list → {ok:true,data}，载荷透传', async () => {
    const res = await fetch(`${baseUrl}/web/api/projects:list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, data: [{ id: 'p1', name: 'demo' }] })
    expect(callLog.at(-1)).toEqual({ channel: 'projects:list', raw: { x: 1 } })
  })

  it('域错误 → 400 + 结构化 code/message；INTERNAL → 500', async () => {
    const bad = await fetch(`${baseUrl}/web/api/projects:boom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', message: '参数校验失败' })

    const internal = await fetch(`${baseUrl}/web/api/crash:internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(internal.status).toBe(500)
  })

  it('非 JSON Content-Type → 415；带斜杠的非法通道 → 404', async () => {
    const res = await fetch(`${baseUrl}/web/api/projects:list`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'
    })
    expect(res.status).toBe(415)
    const evil = await fetch(`${baseUrl}/web/api/a/b`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(evil.status).toBe(404)
  })
})

describe('web/host：安全防护', () => {
  it('Host 非本机字面量（DNS 重绑定）→ 403', async () => {
    // fetch（undici）不允许覆盖 Host 头，用原始 http 请求模拟重绑定站点
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: Number(new URL(baseUrl).port),
          path: '/web/api/projects:list',
          method: 'POST',
          headers: { host: 'evil.example.com:7790', 'content-type': 'application/json' }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(403)
  })

  it('跨站 Origin（CSRF）→ 403；同源 Origin 放行', async () => {
    const evil = await fetch(`${baseUrl}/web/api/projects:list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: '{}'
    })
    expect(evil.status).toBe(403)

    const sameOrigin = await fetch(`${baseUrl}/web/api/projects:list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: '{}'
    })
    expect(sameOrigin.status).toBe(200)
  })
})

describe('web/host：SSE 事件流（broadcastEvent 挂钩推送）', () => {
  it('broadcast → 客户端收到 {channel,payload} JSON 帧', async () => {
    const port = Number(new URL(baseUrl).port)
    const frames = await new Promise<string[]>((resolve, reject) => {
      const chunks: string[] = []
      const req = httpGet(
        { host: '127.0.0.1', port, path: '/web/events', headers: { accept: 'text/event-stream' } },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            chunks.push(chunk)
            if (chunks.join('').includes('proc:statusChanged')) {
              req.destroy()
              resolve(chunks)
            }
          })
          res.on('error', reject)
        }
      )
      req.on('error', (err) => {
        // 主动 destroy 触发的 socket 错误不算失败
        if (chunks.join('').includes('proc:statusChanged')) resolve(chunks)
        else reject(err)
      })
      // 200ms 后触发广播（SSE 已建立）
      setTimeout(() => {
        host.broadcast('proc:statusChanged', { projectId: 'p1', status: 'RUNNING' })
      }, 200)
      setTimeout(() => reject(new Error('SSE 帧等待超时')), 5_000)
    })
    const joined = frames.join('')
    expect(joined).toContain('retry: 3000')
    expect(JSON.parse(joined.slice(joined.indexOf('{')))).toEqual({
      channel: 'proc:statusChanged',
      payload: { projectId: 'p1', status: 'RUNNING' }
    })
  })
})
