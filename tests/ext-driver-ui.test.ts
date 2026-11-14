/**
 * 面板行为判据测(计划 ext-driver-config-ui Phase 3 的机器可验部分)。
 *
 * 本仓库无 DOM 测试环境,面板历史上靠真机目视。这里把"两道门 + 两段式确认 +
 * needsReload 提示"的判断逻辑从 JSX 抽出来单独钉住:真机只需确认渲染接线,
 * 不必再逐条验证规则是否写对。
 */
import { describe, expect, it } from 'vitest';
import { editAffordance, fieldPlaceholder, gateOffWarning, gateResultText, gateStateText, importAffordance, importResultText, importWarningText, isolateOffWarning, removeStep, removeWarningText, resumePoint, savedText, syncGateNotice } from '../client/src/tabs/ext-driver-ui.js';

describe('editAffordance(两道门的可见面)', () => {
  it('arm 状态未回读时不可点并说明在等什么', () => {
    expect(editAffordance(null)).toEqual({ enabled: false, why: '写面状态未知（等待 ext-config-arm 回读）' });
  });
  it('armed 通过;未 armed 透传服务端原因(不能只说"不可写")', () => {
    expect(editAffordance({ armed: true })).toEqual({ enabled: true, why: '' });
    expect(editAffordance({ armed: false, reason: '需要先在记忆面板开启「高权限模式」' }).enabled).toBe(false);
    expect(editAffordance({ armed: false }).why).toBe('驱动配置当前不可写');
  });
});

describe('removeStep(删除两段式)', () => {
  it('第一次问确认,第二次才提交;切到别的驱动重新起算', () => {
    expect(removeStep(null, 'a1')).toBe('arm-confirm');
    expect(removeStep('a1', 'a1')).toBe('commit');
    expect(removeStep('a1', 'b2')).toBe('arm-confirm');
    expect(removeStep('b2', 'b2')).toBe('commit');
  });
});

describe('removeWarningText(删除前把账本说清)', () => {
  it('有账本时列出影子与待推数量,并声明远端不会因此消失', () => {
    const t = removeWarningText('hs1', 12, 3);
    expect(t).toContain('12 条影子账');
    expect(t).toContain('3 个待推任务');
    expect(t).toContain('远端数据不会因此消失');
    expect(t).toContain('重载后不再装配');
  });
  it('无账本时不编造数字', () => {
    const t = removeWarningText('hs1', 0, 0);
    expect(t).toContain('尚无本地账本');
    expect(t).not.toContain('0 条');
  });
});

describe('savedText(needsReload 明示)', () => {
  it('needsReload=true 必须提"重载插件后生效"', () => {
    const t = savedText('new1', true, true, { shadows: 0, outboxPending: 0 });
    expect(t).toContain('已写入 profile');
    expect(t).toContain('重载插件后生效');
    expect(t).toContain('新增 new1');
  });
  it('更新态与影子账保留分别说清,不谎报删除了远端数据', () => {
    const t = savedText('m1', false, true, { shadows: 7, outboxPending: 0 });
    expect(t).toContain('更新 m1');
    expect(t).toContain('7 条影子账保留');
  });
  it('服务端 notice(读回不一致)必须抢在成功文案前面', () => {
    const t = savedText('m1', false, true, { shadows: 0, outboxPending: 0 }, '宿主合并后多出 1 条驱动（id：ghost）');
    expect(t.indexOf('⚠')).toBe(0);
    expect(t.indexOf('ghost')).toBeLessThan(t.indexOf('已写入 profile'));
  });
});

describe('fieldPlaceholder("留空代表什么"必须贴在框上)', () => {
  it('apiKey 编辑态明写"已配置不回显；留空 = 保留原值"', () => {
    expect(fieldPlaceholder('apiKey', true)).toContain('不回显');
    expect(fieldPlaceholder('apiKey', true)).toContain('留空 = 保留原值');
    expect(fieldPlaceholder('apiKey', true)).toContain('secret://ref');
  });
  it('新建态不拿"保留原值"骗人（无原值可保留）', () => {
    expect(fieldPlaceholder('apiKey', false)).not.toContain('不回显');
    expect(fieldPlaceholder('space', false)).toContain('namespace');
    expect(fieldPlaceholder('space', true)).toContain('留空 = 保留原值');
  });
  it('endpoint 给形状示例、extra 给 JSON 形状', () => {
    expect(fieldPlaceholder('endpoint', true)).toContain('https://');
    expect(fieldPlaceholder('extra', true)).toContain('JSON 对象');
    expect(fieldPlaceholder('id', false)).toContain('hs-prod');
  });
});

describe('syncGateNotice(总闸关时同步开关必须是不可拨)', () => {
  it('总闸开 → 不拦', () => {
    expect(syncGateNotice(true)).toEqual({ blocked: false, why: '' });
  });
  it('总闸关 → 拦，并把“拨了为何不生效”说在文案里', () => {
    const g = syncGateNotice(false);
    expect(g.blocked).toBe(true);
    expect(g.why).toContain('ext_memory.enabled=false');
    expect(g.why).toContain('不会改变行为');
  });
});

describe('gateResultText / gateOffWarning(总闸开关的回显与前置警告)', () => {
  it('开启后必须明说“重载后才会生效”，不能让用户以为已装配', () => {
    const t = gateResultText(true);
    expect(t).toContain('重载');
    expect(t).toContain('enabled=true');
    expect(gateResultText(false)).toContain('停用');
  });
  it('服务端读回 notice 抢在成功文案前面', () => {
    const t = gateResultText(true, '读回与提交不一致');
    expect(t.indexOf('⚠')).toBe(0);
    expect(t.indexOf('不一致')).toBeLessThan(t.indexOf('重载'));
  });
  it('停用前警告报出将停下的东西，且不谎称会删数据', () => {
    const w = gateOffWarning(3, 12, 5);
    expect(w).toContain('3 个驱动接入项');
    expect(w).toContain('12 条影子账');
    expect(w).toContain('5 个待推任务');
    expect(w).toContain('不删');
    expect(w).toContain('再开同样需重载');
  });
  it('零账本时不编造数字', () => {
    const w = gateOffWarning(0, 0, 0);
    expect(w).not.toMatch(/0 个/);
    expect(w).toContain('当前无驱动接入项');
  });
});

describe('gateStateText(在不在跑 vs profile 想让它怎样)', () => {
  it('已在跑但配置已改关 → 说“仍在运行”，不说“已关闭”', () => {
    const t = gateStateText(true, false);
    expect(t).toContain('仍在运行');
    expect(t).not.toContain('不存在');
  });
  it('配置已开但尚未装配 → 说“待重载装配”，不让人以为点了没反应', () => {
    const t = gateStateText(false, true);
    expect(t).toContain('已在 profile 开启');
    expect(t).toContain('重载');
  });
  it('两边一致为关 → 才说“未开启”；两边一致为开 → 无提示', () => {
    expect(gateStateText(false, false)).toContain('ext_memory.enabled=false');
    expect(gateStateText(false, undefined)).toContain('ext_memory.enabled=false');
    expect(gateStateText(true, true)).toBe('');
    expect(gateStateText(true, undefined)).toBe('');
  });
});

describe('importAffordance / importWarningText / importResultText（导入面三态）', () => {
  it('导入面未回读 / 未就绪 / 该家无遍历——三种置灰都带原因', () => {
    expect(importAffordance(null, null)).toEqual({ enabled: false, why: '导入面状态未知（等待 ext-config-arm 回读）' });
    expect(importAffordance({ armed: false, reason: '外部记忆未装配' }, null).enabled).toBe(false);
    const noBrowse = importAffordance({ armed: true }, { typeId: 'byterover', browse: false });
    expect(noBrowse.enabled).toBe(false);
    expect(noBrowse.why).toContain('byterover');
    expect(noBrowse.why).toContain('遍历');
    expect(importAffordance({ armed: true }, { typeId: 'mem0', browse: true }).enabled).toBe(true);
  });

  it('导入前警告必须把“逐条向量化”与上限说在点下去之前', () => {
    const w = importWarningText({ driverId: 'hs', maxItems: 2000 });
    expect(w).toContain('2000');
    expect(w).toContain('向量化');
    expect(w).toContain('再点一下确认');
    // 续跑与 md 投射两个额外事实没说就是预览按钮
    expect(importWarningText({ driverId: 'hs', maxItems: 100, resumedFrom: 300 })).toContain('断点');
    expect(importWarningText({ driverId: 'hs', maxItems: 100, memExportOn: true })).toContain('both_dirty');
  });

  it('truncation 非 complete 时不得读成成功，且必须带“未取完/可续”字样', () => {
    const ok = importResultText({ imported: 600, skipped: 0, truncation: 'complete', l1TotalBefore: 10, l1TotalAfter: 610 });
    expect(ok.startsWith('⚠'), 'complete 不得披警示头').toBe(false);
    expect(ok).toContain('末页');
    // 效果凭证：前后总数差就是真新增
    expect(ok).toContain('10 → 610');
    for (const t of ['capped', 'budget', 'cancelled', 'unsupported'] as const) {
      const s = importResultText({ imported: 100, skipped: 5, truncation: t });
      expect(s.startsWith('⚠'), `${t} 必须以警示开头，不能读成成功`).toBe(true);
    }
    expect(importResultText({ imported: 100, skipped: 5, truncation: 'capped' })).toContain('断点');
    expect(importResultText({ imported: 0, skipped: 0, truncation: 'unsupported' })).toContain('不提供遍历');
  });

  it('零条目时不编造“新增 0 条也算完成”的成就感', () => {
    const s = importResultText({ imported: 0, skipped: 0, truncation: 'complete' });
    expect(s).toContain('新增 0 条');
  });
});

describe('isolateOffWarning（关闭隔离闸的两段式第一问）', () => {
  it('必须说“不报错”与“挤出窗口”，且带当量', () => {
    const w = isolateOffWarning(600);
    expect(w).toContain('600');
    expect(w).toContain('挤出窗口');
    expect(w).toContain('不会报错');
    expect(w).toContain('确定关闭');
  });

  it('零外源时不得编造“立刻会有影响”，但要说清以后会有', () => {
    const w = isolateOffWarning(0);
    expect(w).toContain('当前无外源条目');
    expect(w).toContain('一旦导入');
  });
});

describe('resumePoint（“从断点续跑”不能在没有断点时也说）', () => {
  it('上一轮 complete → 不得声称续跑（真机抓到的谎报）', () => {
    expect(resumePoint({ driverId: 'hs', offset: 3000, last: { truncation: 'complete' } }, 'hs')).toBeUndefined();
  });

  it('上一轮 capped/cancelled/budget → 报 offset，且必须同一驱动', () => {
    for (const t of ['capped', 'cancelled', 'budget'] as const) {
      expect(resumePoint({ driverId: 'hs', offset: 500, last: { truncation: t } }, 'hs'), t).toBe(500);
    }
    expect(resumePoint({ driverId: 'OTHER', offset: 500, last: { truncation: 'capped' } }, 'hs')).toBeUndefined();
  });

  it('从未跑过 / 零偏移 → 不出数', () => {
    expect(resumePoint(null, 'hs')).toBeUndefined();
    expect(resumePoint({ driverId: 'hs', offset: 0 }, 'hs')).toBeUndefined();
  });
});
