import { describe, expect, it } from 'vitest'
import type { ProjectWithRuntime } from '@shared/types'
import { isSortKey, sortProjects, uptimeMsOf } from '@renderer/utils/project-sort'

/**
 * 项目排序纯函数单测（v0.6.0）：卡片/列表双视图共用同一排序语义。
 * 重点：缺失值（未运行无 uptime / 无 pid）恒排最后且不随升降序翻转；
 * 状态按语义序（运行中→启动中→异常退出→已停止）而非字典序。
 */

const NOW = 1_000_000_000

function proj(partial: Partial<ProjectWithRuntime> & { id: string; name: string }): ProjectWithRuntime {
  return {
    jarPath: 'D:\\x.jar',
    jdkId: 'j1',
    jvmArgs: [],
    programArgs: [],
    envVars: {},
    status: 'STOPPED',
    ...partial
  }
}

const projects: ProjectWithRuntime[] = [
  proj({ id: 'a', name: 'charlie', status: 'RUNNING', pid: 100, startTime: NOW - 30_000 }),
  proj({ id: 'b', name: 'alpha', status: 'STOPPED' }),
  proj({ id: 'c', name: 'bravo', status: 'STARTING' }),
  proj({ id: 'd', name: 'delta', status: 'ABNORMAL_EXIT', exitCode: 1 }),
  proj({ id: 'e', name: 'echo', status: 'RUNNING', pid: 9, startTime: NOW - 90_000 }),
  proj({ id: 'f', name: 'foxtrot', status: 'RUNNING', startTime: NOW - 10_000 }) // 无 pid
]

const ids = (list: ProjectWithRuntime[]): string[] => list.map((p) => p.id)

describe('renderer/project-sort：sortProjects', () => {
  it('default：保持入参顺序且返回新数组（不修改入参）', () => {
    const input = [...projects]
    const sorted = sortProjects(input, 'default', 'asc', NOW)
    expect(ids(sorted)).toEqual(ids(projects))
    expect(sorted).not.toBe(input)
    expect(ids(input)).toEqual(ids(projects))
  })

  it('name asc/desc：按名称排序并随方向反转', () => {
    // 名称序：alpha < bravo < charlie < delta < echo < foxtrot → b,c,a,d,e,f
    expect(ids(sortProjects(projects, 'name', 'asc', NOW))).toEqual(['b', 'c', 'a', 'd', 'e', 'f'])
    expect(ids(sortProjects(projects, 'name', 'desc', NOW))).toEqual(['f', 'e', 'd', 'a', 'c', 'b'])
  })

  it('name：数值感知（p2 < p10）与中文序', () => {
    const list = [proj({ id: 'x', name: '项目10' }), proj({ id: 'y', name: '项目2' })]
    expect(ids(sortProjects(list, 'name', 'asc', NOW))).toEqual(['y', 'x'])
  })

  it('status：语义序 运行中→启动中→异常退出→已停止；desc 反转', () => {
    expect(ids(sortProjects(projects, 'status', 'asc', NOW))).toEqual([
      'a', 'e', 'f', // RUNNING
      'c', // STARTING
      'd', // ABNORMAL_EXIT
      'b' // STOPPED
    ])
    // desc 反转：STOPPED → ABNORMAL_EXIT → STARTING → RUNNING 组（组内按 id 兜底）
    expect(ids(sortProjects(projects, 'status', 'desc', NOW))).toEqual([
      'b', 'd', 'c', 'a', 'e', 'f'
    ])
  })

  it('uptime：运行久的排前（asc）；未运行的恒排最后且不随方向翻转', () => {
    // uptime：e=90s > a=30s > f=10s；b/c/d 无运行时间
    expect(ids(sortProjects(projects, 'uptime', 'asc', NOW))).toEqual(['f', 'a', 'e', 'b', 'c', 'd'])
    // desc：运行久在前，但"无运行时间"仍恒排最后（不翻到最前）
    expect(ids(sortProjects(projects, 'uptime', 'desc', NOW))).toEqual(['e', 'a', 'f', 'b', 'c', 'd'])
  })

  it('pid：数值序（9 < 100）；无 pid 的恒排最后且不随方向翻转', () => {
    // pid：e=9 < a=100；b/c/d/f 无 pid
    expect(ids(sortProjects(projects, 'pid', 'asc', NOW))).toEqual(['e', 'a', 'b', 'c', 'd', 'f'])
    expect(ids(sortProjects(projects, 'pid', 'desc', NOW))).toEqual(['a', 'e', 'b', 'c', 'd', 'f'])
  })

  it('主键相等时按 id 兜底，顺序确定', () => {
    const list = [
      proj({ id: 'z2', name: 'same', status: 'STOPPED' }),
      proj({ id: 'z1', name: 'same', status: 'STOPPED' })
    ]
    expect(ids(sortProjects(list, 'name', 'asc', NOW))).toEqual(['z1', 'z2'])
  })
})

describe('renderer/project-sort：辅助函数', () => {
  it('uptimeMsOf：仅 RUNNING 且有 startTime 才有值', () => {
    expect(uptimeMsOf(projects[0]!, NOW)).toBe(30_000)
    expect(uptimeMsOf(projects[1]!, NOW)).toBeUndefined() // STOPPED
    expect(uptimeMsOf(proj({ id: 'g', name: 'g', status: 'RUNNING' }), NOW)).toBeUndefined()
  })

  it('isSortKey：仅接受白名单字段', () => {
    expect(isSortKey('name')).toBe(true)
    expect(isSortKey('uptime')).toBe(true)
    expect(isSortKey('default')).toBe(true)
    expect(isSortKey('evil')).toBe(false)
    expect(isSortKey(undefined)).toBe(false)
  })
})
