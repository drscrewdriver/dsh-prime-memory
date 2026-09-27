/**
 * N1 / P0-2 双形状单测：
 * 1. `isOwnRecallSource`——召回份额估算的署名判据，v4（`plugin:memory`）与
 *    v3 旧行（`kind:'plugin'` + `plugin:'memory'`）都必须命中；漏判旧形状会让
 *    "记忆召回份额"静默归零（无异常、无报错，只有测试能钉住）。
 * 2. `projectEventText` 的 `tool/result` native 形状——v4 一等 `role:'tool'`
 *    消息（isError 顶层），漏掉 native 分支会让取证文本恒为空串。
 */
import { describe, expect, it } from 'vitest'
import { isOwnRecallSource } from '../src/hooks/recall.ts'
import { projectEventText } from '../src/store/evidence-source.ts'

describe('isOwnRecallSource：新旧署名形状双判（P0-2 回归钉子）', () => {
  it('v4 producer-owned 命中', () => {
    expect(isOwnRecallSource({ kind: 'plugin:memory', form: 'recall' })).toBe(true)
  })

  it('v3 旧行（宿主迁移前）命中', () => {
    expect(isOwnRecallSource({ kind: 'plugin', plugin: 'memory', form: 'recall' })).toBe(true)
  })

  it('它者一律不命中', () => {
    expect(isOwnRecallSource({ kind: 'plugin:memory', form: 'notice' })).toBe(false)
    expect(isOwnRecallSource({ kind: 'plugin', plugin: 'other', form: 'recall' })).toBe(false)
    expect(isOwnRecallSource({ kind: 'user' })).toBe(false)
    expect(isOwnRecallSource(undefined)).toBe(false)
    expect(isOwnRecallSource(null)).toBe(false)
  })
})

describe('projectEventText：tool/result 双形状（N1 回归钉子）', () => {
  it('v4 native（role:tool，顶层 isError）取到文本且报错带前缀', () => {
    const okEvent = {
      type: 'tool/result',
      seq: 1,
      time: 1,
      data: { message: { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '工具输出' }] } },
    }
    const errEvent = {
      type: 'tool/result',
      seq: 2,
      time: 2,
      data: { message: { role: 'tool', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'boom' }] } },
    }
    expect(projectEventText(okEvent as never)).toBe('工具输出')
    expect(projectEventText(errEvent as never)).toBe('[工具报错] boom')
  })

  it('v3 wrapper（tool-result 块）历史兼容不回退', () => {
    const wrapper = {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: {
        message: {
          source: { kind: 'tool', callId: 'c3' },
          content: [{ type: 'tool-result', toolCallId: 'c3', isError: true, content: [{ type: 'text', text: '旧格式报错' }] }],
        },
      },
    }
    expect(projectEventText(wrapper as never)).toBe('[工具报错] 旧格式报错')
  })
})
