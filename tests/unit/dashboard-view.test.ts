// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import DashboardView from '@renderer/views/DashboardView.vue'
import type { ProjectWithRuntime } from '@shared/types'

/**
 * 渲染层组件测试（v0.6.0）：项目面板卡片/列表双视图 + 排序 + 分页。
 * window.api mock 25 个项目（名称倒序、状态混合）——
 * 验证视图切换（localStorage 持久化/恢复）、表头排序对行序与卡片序同时生效、
 * 未运行项目在运行时间排序下恒沉底、分页翻页子集正确、列表视图多选批量仍走单项通道。
 */

// el-table 全量行渲染 + fixed 列克隆在 happy-dom 下较重，单用例放宽默认 5s 超时
vi.setConfig({ testTimeout: 30_000 })

// el-table 布局观测依赖 ResizeObserver；happy-dom 未提供时补一个空实现
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// happy-dom 21 不实现 WebStorage：装一个内存版 localStorage 供组件偏好持久化测试用
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}
Object.assign(globalThis, { localStorage: new MemoryStorage() })

const NOW = Date.now()

const projects: ProjectWithRuntime[] = Array.from({ length: 25 }, (_, i) => {
  const base = {
    // id 补零：沉底组 id 兜底排序时字符串序 == 数值序，断言可读
    id: `p${String(i).padStart(2, '0')}`,
    // store 顺序故意按名称倒序：svc-25 在前、svc-01 在后，排序效果一目了然
    name: `svc-${String(25 - i).padStart(2, '0')}`,
    jarPath: `D:\\svc-${i}.jar`,
    jdkId: 'j1',
    jvmArgs: [] as string[],
    programArgs: [] as string[],
    envVars: {} as Record<string, string>
  }
  if (i === 0) return { ...base, status: 'RUNNING' as const, pid: 1000, startTime: NOW - 100_000 }
  if (i === 1) return { ...base, status: 'RUNNING' as const, pid: 900, startTime: NOW - 50_000 }
  if (i === 2) return { ...base, status: 'STARTING' as const }
  if (i === 3) return { ...base, status: 'ABNORMAL_EXIT' as const, exitCode: 1 }
  return { ...base, status: 'STOPPED' as const }
})

const opCalls: string[] = []

function mockWindowApi(): void {
  Object.assign(window, {
    api: {
      invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
        if (channel === 'projects:list') return projects
        if (channel === 'jdk:list') return []
        if (channel === 'app:getVersion') return '0.6.0-test'
        if (channel === 'projects:start' || channel === 'projects:stop' || channel === 'projects:restart') {
          const id = (args[0] as { id: string }).id
          opCalls.push(`${channel.split(':')[1]}:${id}`)
          return { ok: true, pid: 100 }
        }
        return {}
      },
      on: () => () => {}
    }
  })
}

async function mountView(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(DashboardView, { global: { plugins: [ElementPlus] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** 切换右上角视图单选（卡片/列表） */
async function switchView(wrapper: ReturnType<typeof mount>, mode: 'card' | 'list'): Promise<void> {
  const radio = wrapper
    .findAll('input[type="radio"]')
    .find((r) => (r.element as HTMLInputElement).value === mode)
  expect(radio, `视图切换按钮「${mode}」应存在`).toBeDefined()
  await radio!.setValue(true)
  await flushPromises()
}

/** 点击列表表头排序（点 th 或其内部 .caret-wrapper，EP 两个版本挂点不同） */
async function clickHeaderSort(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const th = wrapper.findAll('th').find((t) => t.text().includes(label))
  expect(th, `表头「${label}」应存在`).toBeDefined()
  const caret = th!.find('.caret-wrapper')
  await (caret.exists() ? caret : th!).trigger('click')
  await flushPromises()
}

/** 主表格（排除 fixed 列克隆表）当前页行 */
function tableRows(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.el-table__body-wrapper tbody tr')
}

function rowText(wrapper: ReturnType<typeof mount>, index: number): string {
  return tableRows(wrapper)[index]!.text()
}

beforeEach(() => {
  opCalls.length = 0
  localStorage.clear()
  mockWindowApi()
  setActivePinia(createPinia())
})

describe('renderer/DashboardView：卡片/列表双视图 + 排序 + 分页', () => {
  it('默认卡片视图；无表格', async () => {
    const wrapper = await mountView()
    expect(wrapper.findAll('.project-card')).toHaveLength(25)
    expect(wrapper.find('.el-table').exists()).toBe(false)
    wrapper.unmount()
  })

  it('切换到列表视图：表格 + 分页（默认每页 20 行），偏好写入 localStorage 且重挂载后恢复', async () => {
    const wrapper = await mountView()
    await switchView(wrapper, 'list')

    expect(wrapper.find('.el-table').exists()).toBe(true)
    expect(tableRows(wrapper)).toHaveLength(20) // 25 项默认 pageSize 20
    expect(localStorage.getItem('javamgr.dashboard.view')).toBe('list')
    wrapper.unmount()

    // 重挂载（模拟下次打开应用）：视图偏好从 localStorage 恢复
    const again = await mountView()
    expect(again.find('.el-table').exists()).toBe(true)
    expect(tableRows(again)).toHaveLength(20)
    again.unmount()
  })

  it('分页：翻到第 2 页显示剩余 5 行（默认顺序 svc-05 起头）', async () => {
    const wrapper = await mountView()
    await switchView(wrapper, 'list')

    await wrapper.find('.el-pagination .btn-next').trigger('click')
    await flushPromises()
    expect(tableRows(wrapper)).toHaveLength(5)
    // store 顺序 svc-25→svc-01，第 21 项 = svc-05
    expect(rowText(wrapper, 0)).toContain('svc-05')
    wrapper.unmount()
  })

  it('表头按名称排序：升序 svc-01 起头 → 再点降序 svc-25 起头；排序写入 localStorage', async () => {
    const wrapper = await mountView()
    await switchView(wrapper, 'list')

    await clickHeaderSort(wrapper, '名称')
    expect(rowText(wrapper, 0)).toContain('svc-01')
    expect(rowText(wrapper, 19)).toContain('svc-20') // 升序第 1 页末尾
    expect(localStorage.getItem('javamgr.dashboard.sortKey')).toBe('name')
    expect(localStorage.getItem('javamgr.dashboard.sortOrder')).toBe('asc')

    await clickHeaderSort(wrapper, '名称')
    expect(rowText(wrapper, 0)).toContain('svc-25')
    expect(localStorage.getItem('javamgr.dashboard.sortOrder')).toBe('desc')
    wrapper.unmount()
  })

  it('运行时间排序：运行中的在前、未运行的恒沉底（升降序皆然）', async () => {
    const wrapper = await mountView()
    await switchView(wrapper, 'list')

    await clickHeaderSort(wrapper, '运行时间')
    // 升序 = 运行时间短的在前：svc-24（50s）→ svc-25（100s）→ 无运行时间者沉底
    // （沉底组按 id 兜底：STARTING 的 p2 最前，其后 ABNORMAL_EXIT、STOPPED）
    expect(rowText(wrapper, 0)).toContain('svc-24')
    expect(rowText(wrapper, 1)).toContain('svc-25')
    expect(rowText(wrapper, 2)).toContain('svc-23') // STARTING，无运行时间
    expect(rowText(wrapper, tableRows(wrapper).length - 1)).toContain('已停止')

    await clickHeaderSort(wrapper, '运行时间') // 降序：最久在前，但沉底组不动
    expect(rowText(wrapper, 0)).toContain('svc-25')
    expect(rowText(wrapper, 1)).toContain('svc-24')
    expect(rowText(wrapper, tableRows(wrapper).length - 1)).toContain('已停止')
    wrapper.unmount()
  })

  it('排序对卡片视图同样生效（列表排序后切回卡片，顺序一致）', async () => {
    const wrapper = await mountView()
    await switchView(wrapper, 'list')
    await clickHeaderSort(wrapper, '名称') // 升序

    await switchView(wrapper, 'card')
    const firstCard = wrapper.find('.project-card .name')
    expect(firstCard.text()).toBe('svc-01')
    wrapper.unmount()
  })

  it('列表视图多选批量：勾选两行走单项启动通道', async () => {
    const wrapper = await mountView()
    await switchView(wrapper, 'list')

    const checkboxes = wrapper.findAll('.el-table__body-wrapper input[type="checkbox"]')
    expect(checkboxes.length).toBeGreaterThan(2)
    await checkboxes[0]!.setValue(true)
    await checkboxes[1]!.setValue(true)
    await flushPromises()

    const btn = wrapper.findAll('button').find((b) => b.text() === '启动所选')!
    await btn.trigger('click')
    await flushPromises()
    expect(opCalls.length).toBe(2)
    expect(opCalls[0]).toMatch(/^start:p\d+$/)
    wrapper.unmount()
  })
})
