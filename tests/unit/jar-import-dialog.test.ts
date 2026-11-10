// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import JarImportDialog from '@renderer/components/JarImportDialog.vue'

/**
 * 渲染层组件测试（2026-11-10）：jar 扫描导入对话框全流程。
 * window.api mock（jdk:list / projects:scanJars / projects:create）：
 * 扫描 → 已纳管行禁用不可勾选 → 指派 JDK（vm 侧置行状态，等价批量应用后）→
 * 批量新增载荷正确、成功后关闭并 emitted('imported')。
 */

const createdPayloads: Array<{ name: string; jarPath: string; jdkId: string }> = []
let createShouldFailFor: string | null = null

function mockWindowApi(): void {
  Object.assign(window, {
    api: {
      invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
        if (channel === 'jdk:list')
          return [
            { id: 'jdk-17', name: 'Temurin 17', homePath: 'D:\\java17', version: '17', vendor: 'Temurin', source: 'manual' }
          ]
        if (channel === 'projects:scanJars') {
          const rootDir = (args[0] as { rootDir: string }).rootDir
          if (rootDir === 'D:\\bad') throw new Error('扫描路径不是目录：D:\\bad')
          return {
            jars: [
              { path: 'D:\\lib\\alpha.jar', suggestedName: 'alpha', sizeBytes: 1024, mtimeIso: '2026-11-10T00:00:00.000Z', alreadyManaged: false },
              { path: 'D:\\lib\\beta.jar', suggestedName: 'beta', sizeBytes: 2048, mtimeIso: '2026-11-10T00:00:00.000Z', alreadyManaged: false },
              { path: 'D:\\lib\\dup.jar', suggestedName: 'dup', sizeBytes: 32, mtimeIso: '2026-11-10T00:00:00.000Z', alreadyManaged: true }
            ],
            truncated: false,
            skippedDirs: []
          }
        }
        if (channel === 'projects:create') {
          const input = args[0] as { name: string; jarPath: string; jdkId: string }
          if (input.name === createShouldFailFor) throw new Error('项目名称已存在（mock）')
          createdPayloads.push(input)
          return { id: `gen-${createdPayloads.length}`, ...input }
        }
        return {}
      },
      on: () => () => {}
    }
  })
}

/** script-setup 绑定经 dev 构建 instance proxy 暴露（vitest 跑 Vue dev build） */
interface DialogVm {
  rows: Array<{ entry: { path: string; alreadyManaged: boolean }; checked: boolean; name: string; jdkId: string }>
  bulkJdkId: string
}

function vmOf(wrapper: ReturnType<typeof mount>): DialogVm {
  return wrapper.vm as unknown as DialogVm
}

async function scan(wrapper: ReturnType<typeof mount>, dir = 'D:\\lib'): Promise<void> {
  const dirInput = wrapper.find('.dir-input input')
  ;(dirInput.element as HTMLInputElement).value = dir
  await dirInput.trigger('input')
  const scanBtn = wrapper.findAll('button').find((b) => b.text() === '开始扫描')!
  await scanBtn.trigger('click')
  await flushPromises()
}

async function clickCreate(wrapper: ReturnType<typeof mount>): Promise<void> {
  const btn = wrapper.findAll('button').find((b) => b.text().includes('批量新增'))!
  await btn.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  createdPayloads.length = 0
  createShouldFailFor = null
  mockWindowApi()
  setActivePinia(createPinia())
})

describe('renderer/JarImportDialog：扫描导入流程', () => {
  it('扫描 → 3 行渲染（已纳管行禁用且默认不勾选，其余默认勾选）', async () => {
    const wrapper = mount(JarImportDialog, {
      props: { visible: true },
      global: { plugins: [ElementPlus] }
    })
    await flushPromises()
    await scan(wrapper)

    expect(wrapper.findAll('.row')).toHaveLength(3)
    const checkboxes = wrapper.findAll('.row input[type="checkbox"]')
    expect((checkboxes[2]!.element as HTMLInputElement).disabled).toBe(true) // 已纳管
    const vm = vmOf(wrapper)
    expect(vm.rows[0]).toMatchObject({ checked: true, name: 'alpha' })
    expect(vm.rows[1]).toMatchObject({ checked: true, name: 'beta' })
    expect(vm.rows[2]).toMatchObject({ checked: false, name: 'dup' }) // 已纳管默认不勾选
    wrapper.unmount()
  })

  it('未绑定 JDK 时提交被行内校验拦截（不发 create）', async () => {
    const wrapper = mount(JarImportDialog, {
      props: { visible: true },
      global: { plugins: [ElementPlus] }
    })
    await flushPromises()
    await scan(wrapper)
    await clickCreate(wrapper)
    expect(createdPayloads).toHaveLength(0) // jdkId 空 → 校验失败，未发 IPC
    wrapper.unmount()
  })

  it('指派 JDK → 批量新增：默认名/jarPath/jdkId 载荷正确，成功后 emitted imported 并关闭', async () => {
    const wrapper = mount(JarImportDialog, {
      props: { visible: true },
      global: { plugins: [ElementPlus] }
    })
    await flushPromises()
    await scan(wrapper)

    // 模拟"应用到所选"后的行状态（批量应用 UI 交互在 happy-dom 下不可靠，直改 vm 行状态）
    const vm = vmOf(wrapper)
    for (const row of vm.rows) if (row.checked) row.jdkId = 'jdk-17'
    await flushPromises()

    await clickCreate(wrapper)
    expect(createdPayloads).toHaveLength(2)
    expect(createdPayloads[0]).toMatchObject({ name: 'alpha', jarPath: 'D:\\lib\\alpha.jar', jdkId: 'jdk-17' })
    expect(createdPayloads[1]).toMatchObject({ name: 'beta', jarPath: 'D:\\lib\\beta.jar', jdkId: 'jdk-17' })
    expect(wrapper.emitted('imported')).toHaveLength(1)
    expect(wrapper.emitted('update:visible')?.at(-1)).toEqual([false]) // 全部成功 → 关闭对话框
    wrapper.unmount()
  })

  it('部分失败：失败行保留勾选供修正，不 emit 关闭成功语义混淆', async () => {
    createShouldFailFor = 'beta'
    const wrapper = mount(JarImportDialog, {
      props: { visible: true },
      global: { plugins: [ElementPlus] }
    })
    await flushPromises()
    await scan(wrapper)

    const vm = vmOf(wrapper)
    for (const row of vm.rows) if (row.checked) row.jdkId = 'jdk-17'
    await flushPromises()
    await clickCreate(wrapper)

    expect(createdPayloads).toHaveLength(1) // 仅 alpha 成功
    expect(wrapper.emitted('imported')).toHaveLength(1) // 有成功即通知父刷新
    const after = vmOf(wrapper).rows
    expect(after.find((r) => r.name === 'alpha')?.checked).toBe(false) // 成功行取消勾选
    expect(after.find((r) => r.name === 'beta')?.checked).toBe(true) // 失败行保留
    wrapper.unmount()
  })
})
