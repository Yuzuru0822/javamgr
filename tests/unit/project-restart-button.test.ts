// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import ProjectCard from '@renderer/components/ProjectCard.vue'
import ProjectTable from '@renderer/components/ProjectTable.vue'
import type { ProjectWithRuntime } from '@shared/types'

function project(status: ProjectWithRuntime['status']): ProjectWithRuntime {
  return {
    id: `p-${status}`,
    name: `项目-${status}`,
    jarPath: 'D:\\fixture\\app.jar',
    jdkId: 'jdk-1',
    jvmArgs: [],
    programArgs: [],
    envVars: {},
    status,
    ...(status === 'RUNNING' ? { pid: 1234, startTime: Date.now() - 1000 } : {})
  }
}

function restartButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === '重启')
  expect(button, '重启按钮应存在').toBeDefined()
  return button!
}

describe('项目操作：重启按钮状态', () => {
  it('卡片视图：RUNNING 可重启，STOPPED 禁用', async () => {
    const running = mount(ProjectCard, {
      props: { project: project('RUNNING'), jdkName: 'JDK 17', now: Date.now(), selected: false },
      global: { plugins: [ElementPlus] }
    })
    const runningButton = restartButton(running)
    expect(runningButton.attributes('disabled')).toBeUndefined()
    await runningButton.trigger('click')
    expect(running.emitted('restart')).toEqual([['p-RUNNING']])
    running.unmount()

    const stopped = mount(ProjectCard, {
      props: { project: project('STOPPED'), jdkName: 'JDK 17', now: Date.now(), selected: false },
      global: { plugins: [ElementPlus] }
    })
    expect(restartButton(stopped).attributes('disabled')).toBeDefined()
    stopped.unmount()
  })

  it('列表视图：RUNNING 可点击并上抛 restart，STOPPED 禁用', async () => {
    const wrapper = mount(ProjectTable, {
      props: {
        projects: [project('RUNNING'), project('STOPPED')],
        jdkNames: new Map([['jdk-1', 'JDK 17']]),
        now: Date.now(),
        selectedIds: new Set<string>(),
        sortKey: 'default',
        sortOrder: 'asc'
      },
      global: { plugins: [ElementPlus] },
      attachTo: document.body
    })
    await flushPromises()
    const rows = wrapper.findAll('.el-table__body-wrapper tbody tr')
    expect(rows).toHaveLength(2)

    const runningButton = rows[0]!.findAll('button').find((button) => button.text() === '重启')!
    expect(runningButton.attributes('disabled')).toBeUndefined()
    await runningButton.trigger('click')
    expect(wrapper.emitted('restart')).toEqual([['p-RUNNING']])

    const stoppedButton = rows[1]!.findAll('button').find((button) => button.text() === '重启')!
    expect(stoppedButton.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
