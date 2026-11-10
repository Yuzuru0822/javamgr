// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import DashboardView from '@renderer/views/DashboardView.vue'
import type { ProjectWithRuntime } from '@shared/types'

/**
 * 渲染层组件测试（2026-11-10）：项目面板多选批量 启动/重启/停止。
 * 真实 Element Plus 挂载 DashboardView，window.api mock 记录单项启停通道调用——
 * 验证「所选子集」只对勾选项目发起（与全部启动/停止同语义：走单项通道）。
 */

const projects: ProjectWithRuntime[] = [
  { id: 'p1', name: 'alpha', jarPath: 'D:\\a.jar', jdkId: 'j1', jvmArgs: [], programArgs: [], envVars: {}, status: 'STOPPED' },
  { id: 'p2', name: 'beta', jarPath: 'D:\\b.jar', jdkId: 'j1', jvmArgs: [], programArgs: [], envVars: {}, status: 'RUNNING', pid: 11 },
  { id: 'p3', name: 'gamma', jarPath: 'D:\\c.jar', jdkId: 'j1', jvmArgs: [], programArgs: [], envVars: {}, status: 'STOPPED' }
]

const opCalls: string[] = []

function mockWindowApi(): void {
  Object.assign(window, {
    api: {
      invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
        if (channel === 'projects:list') return projects
        if (channel === 'jdk:list') return []
        if (channel === 'app:getVersion') return '0.2.0-test'
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

beforeEach(() => {
  opCalls.length = 0
  mockWindowApi()
  setActivePinia(createPinia())
})

/** 卡片复选框（index 0 = 工具栏全选，1..N = 各卡片） */
function cardCheckbox(wrapper: ReturnType<typeof mount>, cardIndex: number) {
  return wrapper.findAll('input[type="checkbox"]')[cardIndex + 1]!
}

async function clickButton(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  const btn = wrapper.findAll('button').find((b) => b.text() === text)
  expect(btn, `按钮「${text}」应存在`).toBeDefined()
  await btn!.trigger('click')
  await flushPromises()
}

describe('renderer/DashboardView：多选批量操作', () => {
  it('勾选部分卡片 → 启动所选：仅对勾选项目走单项启动通道', async () => {
    const wrapper = mount(DashboardView, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.findAll('.project-card')).toHaveLength(3)

    // 勾选 p1、p3（未勾 p2）
    await cardCheckbox(wrapper, 0).setValue(true)
    await cardCheckbox(wrapper, 2).setValue(true)
    await flushPromises()

    await clickButton(wrapper, '启动所选')
    expect(opCalls.sort()).toEqual(['start:p1', 'start:p3'])

    wrapper.unmount()
  })

  it('停止所选 / 重启所选：同款子集透传', async () => {
    const wrapper = mount(DashboardView, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    await cardCheckbox(wrapper, 1).setValue(true) // 仅 p2
    await clickButton(wrapper, '停止所选')
    expect(opCalls).toEqual(['stop:p2'])

    await clickButton(wrapper, '重启所选')
    expect(opCalls).toEqual(['stop:p2', 'restart:p2'])

    wrapper.unmount()
  })

  it('未勾选时批量按钮禁用；全选后统计（3/3）且批量作用于全部', async () => {
    const wrapper = mount(DashboardView, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    const startBtn = wrapper.findAll('button').find((b) => b.text() === '启动所选')!
    expect(startBtn.element.hasAttribute('disabled')).toBe(true) // 未勾选禁用

    await cardCheckbox(wrapper, -1).setValue(true) // 工具栏全选（index 0）
    await flushPromises()
    expect(wrapper.text()).toContain('3/3')

    await clickButton(wrapper, '启动所选')
    expect(opCalls.sort()).toEqual(['start:p1', 'start:p2', 'start:p3'])

    wrapper.unmount()
  })
})
