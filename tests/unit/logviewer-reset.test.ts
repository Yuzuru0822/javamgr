// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import { defineComponent, h, nextTick } from 'vue'
import LogFilterBar from '@renderer/components/LogFilterBar.vue'
import LogViewer from '@renderer/components/LogViewer.vue'
import { useLogsStore } from '@renderer/stores/logs'
import { useProjectsStore } from '@renderer/stores/projects'
import type { ProjectWithRuntime } from '@shared/types'

/**
 * 渲染层组件测试（2026-11-10）：日志查看器「重置」按钮失效修复的回归测试。
 * 真实 Element Plus 组件挂载（happy-dom），复刻 LogViewer ↔ LogFilterBar 的
 * v-model 绑定链路（v-model 直绑 pinia store 属性 + @clear 回置 store）。
 * window.api 以最小 mock 注入（readHistory / projects:list / on）。
 */

// ---------- window.api 最小 mock（preload 泛型契约的测试替身） ----------

const project: ProjectWithRuntime = {
  id: 'p1',
  name: 'demo',
  jarPath: 'D:\\demo.jar',
  jdkId: 'jdk-17',
  jvmArgs: [],
  programArgs: [],
  envVars: {},
  status: 'RUNNING',
  pid: 123
}

function mockWindowApi(): void {
  Object.assign(window, {
    api: {
      invoke: async (channel: string): Promise<unknown> => {
        if (channel === 'projects:list') return [project]
        if (channel === 'logs:readHistory') return { source: 'stdout', lines: ['INFO a', 'ERROR boom'] }
        return {}
      },
      on: () => () => {}
    }
  })
}

/** 复刻 LogViewer 对 LogFilterBar 的绑定（v-model:keyword/level 直绑 store + @clear） */
const Host = defineComponent({
  setup() {
    const store = useLogsStore()
    return () =>
      h(LogFilterBar, {
        keyword: store.keyword,
        level: store.levelFilter,
        matchCount: 0,
        matchIndex: 0,
        'onUpdate:keyword': (v: string) => {
          store.keyword = v
        },
        'onUpdate:level': (v: string) => {
          store.levelFilter = v as typeof store.levelFilter
        },
        onClear: () => {
          store.keyword = ''
          store.levelFilter = ''
        }
      })
  }
})

async function typeKeyword(wrapper: ReturnType<typeof mount>): Promise<void> {
  const input = wrapper.find('.filter-bar input')
  ;(input.element as HTMLInputElement).value = 'ERROR'
  await input.trigger('input')
  await nextTick()
}

async function clickReset(wrapper: ReturnType<typeof mount>): Promise<void> {
  const reset = wrapper.findAll('button').find((b) => b.text() === '重置')
  expect(reset).toBeDefined()
  await reset!.trigger('click')
  await nextTick()
}

beforeEach(() => {
  mockWindowApi()
  setActivePinia(createPinia())
})

describe('renderer/LogFilterBar：重置按钮（最小链路复刻）', () => {
  it('输入关键字 → 点击重置 → store 与输入框均清空', async () => {
    const wrapper = mount(Host, { global: { plugins: [ElementPlus] } })
    const store = useLogsStore()

    await typeKeyword(wrapper)
    expect(store.keyword).toBe('ERROR')
    expect(wrapper.find('.filter-bar input').element as HTMLInputElement).toHaveProperty('value', 'ERROR')

    await clickReset(wrapper)
    expect(store.keyword).toBe('')
    expect((wrapper.find('.filter-bar input').element as HTMLInputElement).value).toBe('')
  })
})

describe('renderer/LogViewer：重置按钮（完整组件挂载）', () => {
  it('输入关键字过滤生效 → 点击重置 → 过滤解除、输入框清空、视图回到全量并贴底', async () => {
    const projectsStore = useProjectsStore()
    const wrapper = mount(LogViewer, {
      props: { projectId: 'p1' },
      global: { plugins: [ElementPlus] }
    })
    await flushPromises()
    const store = useLogsStore()

    // 前置：历史 2 行已加载（渲染行数 = 视图 displayList 长度）
    expect(projectsStore.projects).toHaveLength(1)
    expect(wrapper.findAll('.line')).toHaveLength(2)

    await typeKeyword(wrapper)
    expect(store.keyword).toBe('ERROR')
    expect(wrapper.findAll('.line')).toHaveLength(1) // 仅命中行 ERROR boom

    await clickReset(wrapper)
    expect(store.keyword).toBe('')
    expect(store.levelFilter).toBe('')
    expect((wrapper.find('.filter-bar input').element as HTMLInputElement).value).toBe('')
    expect(wrapper.findAll('.line')).toHaveLength(2) // 视图恢复全量（非停留过滤视图）

    wrapper.unmount()
  })

  it('「跳到最新」不清空历史（原实现用缓冲替换视图：缓冲不含 readHistory 历史 → 视图跳空）', async () => {
    const wrapper = mount(LogViewer, {
      props: { projectId: 'p1' },
      global: { plugins: [ElementPlus] }
    })
    await flushPromises()

    expect(wrapper.findAll('.line')).toHaveLength(2)
    const jump = wrapper.findAll('button').find((b) => b.text() === '跳到最新')
    expect(jump).toBeDefined()
    await jump!.trigger('click')
    await nextTick()
    expect(wrapper.findAll('.line')).toHaveLength(2) // 历史保留（合并语义，非替换）

    wrapper.unmount()
  })
})
