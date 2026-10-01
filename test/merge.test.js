'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Merge = require('../src/merge.js');

/* ------------------------------ 构造工具 ------------------------------ */

// 草稿行 → 状态：lights 行 {id, name, circuit_id, watts}
const draft = (lights, circuits, cues) => Merge.stateFromDraft({ lights, circuits, cues });

// 版本快照 → 状态
const version = (lights, circuits, wiring, cues) =>
  Merge.stateFromVersion({ lights, circuits, wiring, cues });

const L = (id, name, circuit_id = null, watts = null) => ({ id, name, circuit_id, watts });
const C = (id, name, capacity) => ({ id, name, capacity });
const W = (light_id, circuit_id, watts) => ({ light_id, circuit_id, watts });
const Q = (cue_no, light_id, time, target, duration) => ({ cue_no, light_id, time, target, duration });

const conflictIds = (plan) => plan.conflicts.map((c) => c.id);
const findConflict = (plan, id) => plan.conflicts.find((c) => c.id === id);

/* ------------------------------ 自动合入 ------------------------------ */

test('仅待合入版本改动：灯具改名、回路新增、Cue 新增/删除、接线修改全部自动合入', () => {
  const base = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '侧光' }],
    [{ id: 1, name: '面光回路', capacity: 1500 }],
    [W(1, 1, 300), W(2, null, null)],
    [Q(1, 1, 0, 100, 5), Q(2, 2, 5, 50, 0)]
  );
  const ours = draft(
    [L(1, '面光', 1, 300), L(2, '侧光')],
    [C(1, '面光回路', 1500)],
    [Q(1, 1, 0, 100, 5), Q(2, 2, 5, 50, 0)]
  );
  const theirs = version(
    [{ id: 1, name: '面光A' }, { id: 2, name: '侧光' }],
    [
      { id: 1, name: '面光回路', capacity: 1500 },
      { id: 2, name: '侧光回路', capacity: 800 },
    ],
    [W(1, 1, 500), W(2, null, null)],
    [Q(1, 1, 0, 100, 5), Q(3, 2, 8, 80, 2)] // 删 Cue#2、增 Cue#3
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  assert.deepEqual(conflictIds(plan), []);
  assert.deepEqual(
    plan.auto.lights.map((e) => [e.key, e.action, e.to.name]),
    [[1, 'update', '面光A']]
  );
  assert.deepEqual(
    plan.auto.circuits.map((e) => [e.key, e.action]),
    [[2, 'add']]
  );
  assert.deepEqual(
    plan.auto.wirings.map((e) => [e.key, e.action, e.to.watts]),
    [[1, 'update', 500]]
  );
  assert.deepEqual(
    plan.auto.cues.map((e) => [e.key, e.action]),
    [
      [2, 'delete'],
      [3, 'add'],
    ]
  );
});

test('仅草稿改动：待合入版本未动时不产生任何自动改动与冲突', () => {
  const base = version([{ id: 1, name: '面光' }], [], [W(1, null, null)], [Q(1, 1, 0, 100, 5)]);
  const ours = draft([L(1, '面光B')], [], [Q(1, 1, 0, 90, 5), Q(2, 1, 6, 0, 1)]);
  const theirs = version([{ id: 1, name: '面光' }], [], [W(1, null, null)], [Q(1, 1, 0, 100, 5)]);
  const plan = Merge.computeMergePlan(base, ours, theirs);
  assert.equal(plan.summary.auto_count, 0);
  assert.deepEqual(conflictIds(plan), []);
});

test('两侧改成相同内容：收敛，不产生改动与冲突', () => {
  const base = version([{ id: 1, name: '面光' }], [], [W(1, null, null)], [Q(1, 1, 0, 100, 5)]);
  const ours = draft([L(1, '面光X')], [], [Q(1, 1, 0, 60, 5)]);
  const theirs = version([{ id: 1, name: '面光X' }], [], [W(1, null, null)], [Q(1, 1, 0, 60, 5)]);
  const plan = Merge.computeMergePlan(base, ours, theirs);
  assert.equal(plan.summary.auto_count, 0);
  assert.deepEqual(conflictIds(plan), []);
});

/* ------------------------------- 冲突 ------------------------------- */

test('两侧不同修改 → both_modified，冲突带两侧值', () => {
  const base = version([{ id: 1, name: '面光' }], [], [W(1, null, null)], [Q(1, 1, 0, 100, 5)]);
  const ours = draft([L(1, '面光甲')], [], [Q(1, 1, 0, 70, 5)]);
  const theirs = version([{ id: 1, name: '面光乙' }], [], [W(1, null, null)], [Q(1, 1, 0, 30, 5)]);
  const plan = Merge.computeMergePlan(base, ours, theirs);
  assert.deepEqual(conflictIds(plan), ['light:1', 'cue:1']);
  const c = findConflict(plan, 'light:1');
  assert.equal(c.type, 'both_modified');
  assert.equal(c.ours.name, '面光甲');
  assert.equal(c.theirs.name, '面光乙');
  const q = findConflict(plan, 'cue:1');
  assert.equal(q.ours.target, 70);
  assert.equal(q.theirs.target, 30);
});

test('删除与修改并存 → delete_vs_modify（两个方向）', () => {
  const base = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '侧光' }],
    [],
    [W(1, null, null), W(2, null, null)],
    []
  );
  // 草稿删 1 改 2；待合入改 1 删 2
  const ours = draft([L(2, '侧光甲')], [], []);
  const theirs = version([{ id: 1, name: '面光乙' }], [], [W(1, null, null)], []);
  const plan = Merge.computeMergePlan(base, ours, theirs);
  const c1 = findConflict(plan, 'light:1');
  assert.equal(c1.type, 'delete_vs_modify');
  assert.equal(c1.ours, null);
  assert.equal(c1.theirs.name, '面光乙');
  const c2 = findConflict(plan, 'light:2');
  assert.equal(c2.type, 'delete_vs_modify');
  assert.equal(c2.ours.name, '侧光甲');
  assert.equal(c2.theirs, null);
});

test('同编号新增异值 → both_added', () => {
  const base = version([], [], [], []);
  const ours = draft([L(1, '面光')], [C(1, '甲回路', 1000)], [Q(1, 1, 0, 100, 0)]);
  const theirs = version(
    [{ id: 1, name: '顶光' }],
    [{ id: 1, name: '乙回路', capacity: 2000 }],
    [W(1, 1, 200)],
    [Q(1, 1, 0, 50, 0)]
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  for (const id of ['light:1', 'circuit:1', 'wiring:1', 'cue:1']) {
    assert.equal(findConflict(plan, id).type, 'both_added', id);
  }
});

test('名称重名：待合入把灯具改名为与草稿现有灯具重名 → name_clash', () => {
  const base = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '侧光' }],
    [],
    [W(1, null, null), W(2, null, null)],
    []
  );
  const ours = draft([L(1, '面光'), L(2, '侧光')], [], []);
  const theirs = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '面光' }], // #2 改名为「面光」，与草稿 #1 重名
    [],
    [W(1, null, null), W(2, null, null)],
    []
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  const c = findConflict(plan, 'light:2');
  assert.equal(c.type, 'name_clash');
  assert.equal(c.theirs.name, '面光');
  assert.deepEqual(c.clash_with, { kind: 'light', key: 1, name: '面光' });
  assert.equal(plan.summary.auto_count, 0); // 改名被降级为冲突，不再自动合入
});

test('名称重名：待合入新增回路名与草稿回路重名 → name_clash', () => {
  const base = version([], [{ id: 1, name: '回路A', capacity: 1500 }], [], []);
  const ours = draft([], [C(1, '回路B', 1500)], []); // 草稿把 #1 改名为「回路B」
  const theirs = version(
    [],
    [
      { id: 1, name: '回路A', capacity: 1500 },
      { id: 2, name: '回路B', capacity: 800 }, // 新增 #2 与草稿 #1 重名
    ],
    [],
    []
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  const c = findConflict(plan, 'circuit:2');
  assert.equal(c.type, 'name_clash');
  assert.equal(c.clash_with.key, 1);
  assert.equal(plan.summary.auto_count, 0);
});

test('引用缺失：待合入新增的 Cue 引用草稿已删除的灯具 → missing_reference', () => {
  const base = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '侧光' }],
    [],
    [W(1, null, null), W(2, null, null)],
    [Q(1, 1, 0, 100, 0)]
  );
  const ours = draft([L(1, '面光')], [], [Q(1, 1, 0, 100, 0)]); // 删除了灯具 #2
  const theirs = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '侧光' }],
    [],
    [W(1, null, null), W(2, null, null)],
    [Q(1, 1, 0, 100, 0), Q(2, 2, 5, 80, 1)] // 新增引用灯具 #2 的 Cue
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  const c = findConflict(plan, 'cue:2');
  assert.equal(c.type, 'missing_reference');
  assert.deepEqual(c.missing, { kind: 'light', key: 2 });
  assert.equal(plan.auto.cues.length, 0);
});

test('引用缺失：待合入把灯具改接到草稿已删除的回路 → missing_reference', () => {
  const base = version(
    [{ id: 1, name: '面光' }],
    [
      { id: 1, name: '回路A', capacity: 1000 },
      { id: 2, name: '回路B', capacity: 1000 },
    ],
    [W(1, 1, 300)],
    []
  );
  const ours = draft([L(1, '面光', 1, 300)], [C(1, '回路A', 1000)], []); // 删除回路 #2
  const theirs = version(
    [{ id: 1, name: '面光' }],
    [
      { id: 1, name: '回路A', capacity: 1000 },
      { id: 2, name: '回路B', capacity: 1000 },
    ],
    [W(1, 2, 300)], // 改接到回路 #2
    []
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  const c = findConflict(plan, 'wiring:1');
  assert.equal(c.type, 'missing_reference');
  assert.deepEqual(c.missing, { kind: 'circuit', key: 2 });
});

test('级联：待合入新增重名灯具及其接线/Cue → 三者全部降级为冲突', () => {
  const base = version(
    [{ id: 1, name: '面光' }],
    [{ id: 1, name: '回路A', capacity: 1000 }],
    [W(1, 1, 300)],
    []
  );
  const ours = draft([L(1, '面光', 1, 300)], [C(1, '回路A', 1000)], []);
  const theirs = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '面光' }], // #2 与草稿 #1 重名
    [{ id: 1, name: '回路A', capacity: 1000 }],
    [W(1, 1, 300), W(2, 1, 200)],
    [Q(5, 2, 3, 90, 1)]
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  assert.equal(findConflict(plan, 'light:2').type, 'name_clash');
  assert.equal(findConflict(plan, 'wiring:2').type, 'missing_reference');
  assert.equal(findConflict(plan, 'cue:5').type, 'missing_reference');
  assert.equal(plan.summary.auto_count, 0);
});

/* --------------------------- 冲突解决与验证 --------------------------- */

test('applyResolutions：逐项选择后得到合并结果；缺项/未知项/非法值报错', () => {
  const base = version([{ id: 1, name: '面光' }], [], [W(1, null, null)], [Q(1, 1, 0, 100, 5)]);
  const ours = draft([L(1, '面光甲')], [], [Q(1, 1, 0, 70, 5)]);
  const theirs = version(
    [{ id: 1, name: '面光乙' }],
    [],
    [W(1, null, null)],
    [Q(1, 1, 0, 30, 5), Q(2, 1, 9, 10, 0)]
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);

  const bad1 = Merge.applyResolutions(ours, plan, { 'light:1': 'ours' }); // 缺 cue:1
  assert.match(bad1.error, /cue:1/);
  const bad2 = Merge.applyResolutions(ours, plan, {
    'light:1': 'ours',
    'cue:1': 'ours',
    'cue:99': 'ours',
  });
  assert.match(bad2.error, /未知的冲突编号/);
  const bad3 = Merge.applyResolutions(ours, plan, { 'light:1': 'x', 'cue:1': 'ours' });
  assert.match(bad3.error, /缺少有效选择/);

  const ok = Merge.applyResolutions(ours, plan, { 'light:1': 'theirs', 'cue:1': 'ours' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.merged.lights.get(1).name, '面光乙'); // 采用待合入
  assert.equal(ok.merged.cues.get(1).target, 70); // 保留草稿
  assert.equal(ok.merged.cues.get(2).target, 10); // 自动合入的新增 Cue
  assert.deepEqual(Merge.validateMerged(ok.merged), []);
});

test('validateMerged：重名、引用缺失、瓦数规则、Cue 字段全部检出', () => {
  const st = draft(
    [L(1, '面光'), L(2, '面光'), L(3, '顶光', 9, -5), L(4, '逆光', null, 100)],
    [C(1, '回路A', 1000), C(2, '回路A', 500)],
    [Q(1, 8, 0, 100, 0), Q(2, 1, -1, 100, 0), Q(3, 1, 0, 120, 0), Q(4, 1, 0, 50, -2)]
  );
  const v = Merge.validateMerged(st);
  assert.ok(v.some((s) => s.includes('灯具名称「面光」重复')));
  assert.ok(v.some((s) => s.includes('回路名称「回路A」重复')));
  assert.ok(v.some((s) => s.includes('灯具 #3 的接线引用了不存在的回路 #9')));
  assert.ok(v.some((s) => s.includes('灯具 #3 已分配回路，额定瓦数必须为正数')));
  assert.ok(v.some((s) => s.includes('灯具 #4 未分配回路，不能保留额定瓦数')));
  assert.ok(v.some((s) => s.includes('Cue #1 引用了不存在的灯具 #8')));
  assert.ok(v.some((s) => s.includes('Cue #2 时码必须为非负数字')));
  assert.ok(v.some((s) => s.includes('Cue #3 目标亮度必须在 0～100 之间')));
  assert.ok(v.some((s) => s.includes('Cue #4 渐变时长必须为非负数字')));
});

test('选择仍违反唯一性：validateMerged 拦截（整次拒绝由服务端保证）', () => {
  // 草稿把 #1 改名为「面光2」，待合入新增 #2「面光2」→ name_clash；仍选 theirs → 重名
  const base = version([{ id: 1, name: '面光' }], [], [W(1, null, null)], []);
  const ours = draft([L(1, '面光2')], [], []);
  const theirs = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '面光2' }],
    [],
    [W(1, null, null), W(2, null, null)],
    []
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  assert.equal(findConflict(plan, 'light:2').type, 'name_clash');
  // 新灯具的接线随灯具级联降级为引用缺失冲突，一并选择采用待合入
  assert.equal(findConflict(plan, 'wiring:2').type, 'missing_reference');
  const applied = Merge.applyResolutions(ours, plan, { 'light:2': 'theirs', 'wiring:2': 'theirs' });
  const v = Merge.validateMerged(applied.merged);
  assert.ok(v.some((s) => s.includes('重复')));
});

test('fingerprint：内容相同指纹相同，任一字段变化指纹不同', () => {
  const a = draft([L(1, '面光', 1, 300)], [C(1, '回路A', 1000)], [Q(1, 1, 0, 100, 0)]);
  const b = draft([L(1, '面光', 1, 300)], [C(1, '回路A', 1000)], [Q(1, 1, 0, 100, 0)]);
  assert.equal(Merge.fingerprint(a), Merge.fingerprint(b));
  const c = draft([L(1, '面光', 1, 301)], [C(1, '回路A', 1000)], [Q(1, 1, 0, 100, 0)]);
  assert.notEqual(Merge.fingerprint(a), Merge.fingerprint(c));
  const d = draft(
    [L(1, '面光', 1, 300)],
    [C(1, '回路A', 1000)],
    [Q(1, 1, 0, 100, 0), Q(2, 1, 1, 0, 0)]
  );
  assert.notEqual(Merge.fingerprint(a), Merge.fingerprint(d));
});

test('端到端：自动合入 + 校验通过 + 转草稿行', () => {
  const base = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '侧光' }],
    [{ id: 1, name: '回路A', capacity: 1500 }],
    [W(1, 1, 300), W(2, null, null)],
    [Q(1, 1, 0, 100, 5), Q(2, 2, 5, 50, 0)]
  );
  const ours = draft(
    [L(1, '面光', 1, 300), L(2, '侧光改')], // 草稿改了 #2 名
    [C(1, '回路A', 1500)],
    [Q(1, 1, 0, 100, 5), Q(2, 2, 5, 50, 0)]
  );
  const theirs = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '侧光' }, { id: 3, name: '逆光' }],
    [{ id: 1, name: '回路A', capacity: 1500 }],
    [W(1, 1, 300), W(2, 1, 200), W(3, 1, 250)], // #2 接回路、新增 #3
    [Q(1, 1, 0, 100, 5), Q(2, 2, 5, 60, 0), Q(3, 3, 7, 90, 2)] // 改 Cue#2、增 Cue#3
  );
  const plan = Merge.computeMergePlan(base, ours, theirs);
  // 灯具 #2：草稿改名、待合入未动 → 保留草稿；接线 #2、Cue#2：待合入改 → 自动；
  // #3 灯具/接线/Cue#3：待合入新增 → 自动
  assert.deepEqual(conflictIds(plan), []);
  const applied = Merge.applyResolutions(ours, plan, {});
  assert.equal(applied.error, undefined);
  assert.deepEqual(Merge.validateMerged(applied.merged), []);
  const rows = Merge.stateToDraftRows(applied.merged);
  assert.deepEqual(
    rows.lights.map((l) => [l.id, l.name, l.circuit_id, l.watts]),
    [
      [1, '面光', 1, 300],
      [2, '侧光改', 1, 200],
      [3, '逆光', 1, 250],
    ]
  );
  assert.deepEqual(
    rows.cues.map((c) => [c.cue_no, c.target]),
    [
      [1, 100],
      [2, 60],
      [3, 90],
    ]
  );
});

test('删除与修改并存选择保留修改方：引用缺失由校验检出，冲突上带提示', () => {
  // 待合入删除了灯具 #2（连同其接线与 Cue），草稿修改了 Cue#1 → 冲突；保留草稿 Cue → 引用缺失
  const base = version(
    [{ id: 1, name: '面光' }, { id: 2, name: '侧光' }],
    [],
    [W(1, null, null), W(2, null, null)],
    [Q(1, 2, 0, 100, 0)]
  );
  const ours = draft([L(1, '面光'), L(2, '侧光')], [], [Q(1, 2, 0, 80, 0)]);
  const theirs = version([{ id: 1, name: '面光' }], [], [W(1, null, null)], []);
  const plan = Merge.computeMergePlan(base, ours, theirs);
  const c = findConflict(plan, 'cue:1');
  assert.equal(c.type, 'delete_vs_modify');
  assert.ok(c.ours_warnings.some((w) => w.includes('灯具 #2')));
  const applied = Merge.applyResolutions(ours, plan, { 'cue:1': 'ours' });
  const v = Merge.validateMerged(applied.merged);
  assert.ok(v.some((s) => s.includes('Cue #1 引用了不存在的灯具 #2')));
});
