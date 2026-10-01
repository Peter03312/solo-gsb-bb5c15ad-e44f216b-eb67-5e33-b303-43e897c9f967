'use strict';

/*
 * 版本三方合并（纯函数，无数据库依赖）。
 *
 * 场景：两组排演人员从同一已发布版本（共同基线 base）各自改稿，
 * 需要把另一已发布版本（theirs）合入当前草稿（ours）。
 *
 * 实体与身份：
 *  - 灯具 light：按灯具编号 id，内容 { name }
 *  - 回路 circuit：按回路编号 id，内容 { name, capacity }
 *  - 灯具接线 wiring：按灯具编号，内容 { circuit_id, watts }
 *  - Cue：按 Cue 编号 cue_no，内容 { light_id, time, target, duration }
 *
 * 规则：
 *  - 仅一侧改动、或两侧改成相同内容 → 自动合入；
 *  - 两侧不同改动 / 删除与修改并存 / 同编号新增异值 → 冲突；
 *  - 自动合入后会造成名称重名（灯具、回路分别唯一）或 Cue/接线引用缺失的
 *    改动同样降级为冲突；
 *  - 冲突逐项由调用方选择「保留草稿 ours / 采用待合入版本 theirs」，
 *    合并结果仍须通过 validateMerged 的唯一性与引用校验，否则整次拒绝。
 */

const crypto = require('crypto');

const KINDS = ['light', 'circuit', 'wiring', 'cue'];
const COLL_OF = { light: 'lights', circuit: 'circuits', wiring: 'wirings', cue: 'cues' };
const KIND_LABEL = { light: '灯具', circuit: '回路', wiring: '灯具接线', cue: 'Cue' };
const CONTENT_KEYS = {
  light: ['name'],
  circuit: ['name', 'capacity'],
  wiring: ['circuit_id', 'watts'],
  cue: ['light_id', 'time', 'target', 'duration'],
};

function kindLabel(kind, key) {
  if (kind === 'wiring') return `灯具 #${key} 的接线`;
  if (kind === 'cue') return `Cue #${key}`;
  return `${KIND_LABEL[kind]} #${key}`;
}

function emptyState() {
  return { lights: new Map(), circuits: new Map(), wirings: new Map(), cues: new Map() };
}

/** 草稿行 → 归一化状态。lights 行自带 circuit_id/watts（接线随灯具行存储）。 */
function stateFromDraft({ lights, circuits, cues }) {
  const st = emptyState();
  for (const l of lights) {
    st.lights.set(l.id, { id: l.id, name: l.name });
    st.wirings.set(l.id, {
      light_id: l.id,
      circuit_id: l.circuit_id ?? null,
      watts: l.watts ?? null,
    });
  }
  for (const c of circuits) {
    st.circuits.set(c.id, { id: c.id, name: c.name, capacity: c.capacity });
  }
  for (const c of cues) {
    st.cues.set(c.cue_no, {
      cue_no: c.cue_no,
      light_id: c.light_id,
      time: c.time,
      target: c.target,
      duration: c.duration,
    });
  }
  return st;
}

/** 版本快照（loadVersionSnapshot 的返回）→ 归一化状态。 */
function stateFromVersion(snap) {
  const st = emptyState();
  for (const l of snap.lights) st.lights.set(l.id, { id: l.id, name: l.name });
  for (const c of snap.circuits) {
    st.circuits.set(c.id, { id: c.id, name: c.name, capacity: c.capacity });
  }
  for (const w of snap.wiring) {
    st.wirings.set(w.light_id, {
      light_id: w.light_id,
      circuit_id: w.circuit_id ?? null,
      watts: w.watts ?? null,
    });
  }
  for (const c of snap.cues) {
    st.cues.set(c.cue_no, {
      cue_no: c.cue_no,
      light_id: c.light_id,
      time: c.time,
      target: c.target,
      duration: c.duration,
    });
  }
  return st;
}

/** 归一化状态 → 草稿表行（灯具行带回接线；Cue 按触发时码、编号排序）。 */
function stateToDraftRows(st) {
  const byId = (a, b) => a.id - b.id;
  const lights = [...st.lights.values()].sort(byId).map((l) => {
    const w = st.wirings.get(l.id);
    return {
      id: l.id,
      name: l.name,
      circuit_id: w ? w.circuit_id : null,
      watts: w ? w.watts : null,
    };
  });
  const circuits = [...st.circuits.values()].sort(byId);
  const cues = [...st.cues.values()].sort((a, b) => a.time - b.time || a.cue_no - b.cue_no);
  return { lights, circuits, cues };
}

function cloneState(st) {
  const out = emptyState();
  for (const coll of Object.values(COLL_OF)) {
    for (const [k, v] of st[coll]) out[coll].set(k, { ...v });
  }
  return out;
}

/** 草稿内容指纹：预览时返回，提交时携带；草稿一旦编辑即变化，用于强制重新预览。 */
function fingerprint(st) {
  const canon = {
    lights: [...st.lights.values()].sort((a, b) => a.id - b.id),
    circuits: [...st.circuits.values()].sort((a, b) => a.id - b.id),
    wirings: [...st.wirings.values()].sort((a, b) => a.light_id - b.light_id),
    cues: [...st.cues.values()].sort((a, b) => a.cue_no - b.cue_no),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

function contentEqual(kind, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  return CONTENT_KEYS[kind].every((k) => a[k] === b[k]);
}

function conflictMessage(kind, key, type, o, t, extra) {
  const label = kindLabel(kind, key);
  switch (type) {
    case 'both_modified':
      return `${label}：草稿与待合入版本作了不同修改`;
    case 'delete_vs_modify':
      return o === null
        ? `${label}：草稿已删除，待合入版本有修改`
        : `${label}：草稿有修改，待合入版本已删除`;
    case 'both_added':
      return `${label}：两侧以相同编号新增了不同内容`;
    case 'name_clash':
      return `${label}：采用待合入版本后名称「${t.name}」与草稿中${kindLabel(extra.clash_with.kind, extra.clash_with.key)} 重名`;
    case 'missing_reference': {
      const m = extra.missing;
      return `${label}：采用待合入版本后引用的${kindLabel(m.kind, m.key)} 在合并结果中不存在`;
    }
    default:
      return `${label}：合并冲突`;
  }
}

function makeConflict(kind, key, type, oursVal, theirsVal, extra = {}) {
  return {
    id: `${kind}:${key}`,
    kind,
    key,
    type,
    ours: oursVal,
    theirs: theirsVal,
    ...extra,
    message: conflictMessage(kind, key, type, oursVal, theirsVal, extra),
  };
}

/**
 * 三方比较，产出合并计划：auto（可自动合入、将作用于草稿的改动）与 conflicts。
 * 纯比较，不写库。base/ours/theirs 均为归一化状态。
 */
function computeMergePlan(base, ours, theirs) {
  // 每个实体的暂定取舍：value 为合并结果内容（null = 不存在），source 标记取值来源
  const decisions = {};
  const autoMap = {};
  const conflicts = [];

  for (const kind of KINDS) {
    const coll = COLL_OF[kind];
    decisions[kind] = new Map();
    autoMap[kind] = new Map();
    const keys = new Set([...base[coll].keys(), ...ours[coll].keys(), ...theirs[coll].keys()]);
    for (const key of [...keys].sort((a, b) => a - b)) {
      const b = base[coll].get(key) ?? null;
      const o = ours[coll].get(key) ?? null;
      const t = theirs[coll].get(key) ?? null;
      if (contentEqual(kind, o, t)) {
        // 两侧一致（都未改 / 收敛为相同内容 / 都已删除）：草稿无需改动
        decisions[kind].set(key, { value: o, source: 'ours', conflict: false });
      } else if (contentEqual(kind, b, o)) {
        // 草稿未改 → 采用待合入版本（自动合入，作用于草稿）
        decisions[kind].set(key, { value: t, source: 'theirs', conflict: false });
        autoMap[kind].set(key, {
          kind,
          key,
          action: t === null ? 'delete' : o === null ? 'add' : 'update',
          from: o,
          to: t,
        });
      } else if (contentEqual(kind, b, t)) {
        // 待合入版本未改 → 保留草稿（草稿无需改动）
        decisions[kind].set(key, { value: o, source: 'ours', conflict: false });
      } else {
        const type =
          b === null ? 'both_added' : o === null || t === null ? 'delete_vs_modify' : 'both_modified';
        conflicts.push(makeConflict(kind, key, type, o, t));
        // 冲突未决前暂定保留草稿
        decisions[kind].set(key, { value: o, source: 'ours', conflict: true });
      }
    }
  }

  const present = (kind, key) => {
    const d = decisions[kind].get(key);
    return d !== undefined && d.value !== null;
  };

  // 把会导致重名/引用缺失的自动改动降级为冲突（取值回到草稿侧）
  const demote = (kind, key, type, extra) => {
    const d = decisions[kind].get(key);
    const o = ours[COLL_OF[kind]].get(key) ?? null;
    conflicts.push(makeConflict(kind, key, type, o, d.value, extra));
    decisions[kind].set(key, { value: o, source: 'ours', conflict: true });
    autoMap[kind].delete(key);
  };

  // 迭代至不动点：降级可能级联（如灯具因重名被降级后，其接线/Cue 随之引用缺失）
  let again = true;
  while (again) {
    again = false;
    // 名称重名：草稿与待合入版本各自内部唯一，重名必然一侧一个；降级待合入侧
    for (const kind of ['light', 'circuit']) {
      const byName = new Map();
      for (const [key, d] of decisions[kind]) {
        if (!d.value) continue;
        const list = byName.get(d.value.name) || [];
        list.push({ key, source: d.source });
        byName.set(d.value.name, list);
      }
      for (const [name, list] of byName) {
        if (list.length < 2) continue;
        const partner = list.find((x) => x.source === 'ours') || list[0];
        for (const item of list) {
          if (item.source !== 'theirs') continue;
          demote(kind, item.key, 'name_clash', {
            clash_with: { kind, key: partner.key, name },
          });
          again = true;
        }
      }
    }
    // 引用缺失：Cue → 灯具；接线 → 灯具 / 回路
    for (const [key, d] of decisions.cue) {
      if (!d.value || d.conflict || d.source !== 'theirs') continue;
      if (!present('light', d.value.light_id)) {
        demote('cue', key, 'missing_reference', { missing: { kind: 'light', key: d.value.light_id } });
        again = true;
      }
    }
    for (const [key, d] of decisions.wiring) {
      if (!d.value || d.conflict || d.source !== 'theirs') continue;
      if (!present('light', key)) {
        demote('wiring', key, 'missing_reference', { missing: { kind: 'light', key } });
        again = true;
      } else if (d.value.circuit_id !== null && !present('circuit', d.value.circuit_id)) {
        demote('wiring', key, 'missing_reference', {
          missing: { kind: 'circuit', key: d.value.circuit_id },
        });
        again = true;
      }
    }
  }

  // 为冲突两侧补充提示：该侧取值在当前合并结果（其余冲突暂按草稿）下的引用/重名风险
  const sideWarnings = (kind, key, value) => {
    const warns = [];
    if (value === null) return warns;
    if (kind === 'cue' && !present('light', value.light_id)) {
      warns.push(`引用的灯具 #${value.light_id} 在当前合并结果中不存在`);
    }
    if (kind === 'wiring') {
      if (!present('light', key)) warns.push(`对应灯具 #${key} 在当前合并结果中不存在`);
      if (value.circuit_id !== null && !present('circuit', value.circuit_id)) {
        warns.push(`引用的回路 #${value.circuit_id} 在当前合并结果中不存在`);
      }
    }
    if ((kind === 'light' || kind === 'circuit') && value.name) {
      for (const [k2, d2] of decisions[kind]) {
        if (k2 !== key && d2.value && d2.value.name === value.name) {
          warns.push(`名称「${value.name}」与${kindLabel(kind, k2)}重名`);
        }
      }
    }
    return warns;
  };
  for (const c of conflicts) {
    c.ours_warnings = sideWarnings(c.kind, c.key, c.ours);
    c.theirs_warnings = sideWarnings(c.kind, c.key, c.theirs);
  }

  const KIND_ORDER = { light: 0, circuit: 1, wiring: 2, cue: 3 };
  conflicts.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key - b.key);

  const auto = { lights: [], circuits: [], wirings: [], cues: [] };
  for (const kind of KINDS) {
    for (const e of autoMap[kind].values()) auto[COLL_OF[kind]].push(e);
  }
  const autoCount = KINDS.reduce((n, kind) => n + auto[COLL_OF[kind]].length, 0);

  return { auto, conflicts, summary: { auto_count: autoCount, conflict_count: conflicts.length } };
}

/**
 * 按逐项冲突选择计算合并结果。
 * resolutions：{ "冲突id": "ours" | "theirs" }，必须恰好覆盖计划中的全部冲突。
 * 返回 { merged } 或 { error }。
 */
function applyResolutions(ours, plan, resolutions) {
  if (resolutions === null || typeof resolutions !== 'object' || Array.isArray(resolutions)) {
    return { error: 'resolutions 必须是对象：{ "冲突id": "ours"（保留草稿）或 "theirs"（采用待合入版本） }' };
  }
  const byId = new Map(plan.conflicts.map((c) => [c.id, c]));
  for (const c of plan.conflicts) {
    const choice = resolutions[c.id];
    if (choice !== 'ours' && choice !== 'theirs') {
      return {
        error: `冲突 ${c.id}（${c.message}）缺少有效选择：须为 "ours" 保留草稿 或 "theirs" 采用待合入版本`,
      };
    }
  }
  for (const id of Object.keys(resolutions)) {
    if (!byId.has(id)) {
      return { error: `未知的冲突编号：${id}（请重新预览后按最新冲突列表提交）` };
    }
  }

  const merged = cloneState(ours);
  const setValue = (kind, key, value) => {
    const coll = COLL_OF[kind];
    if (value === null) merged[coll].delete(key);
    else merged[coll].set(key, { ...value });
  };
  for (const kind of KINDS) {
    for (const e of plan.auto[COLL_OF[kind]]) setValue(kind, e.key, e.to);
  }
  for (const c of plan.conflicts) {
    setValue(c.kind, c.key, resolutions[c.id] === 'theirs' ? c.theirs : c.ours);
  }
  return { merged };
}

/**
 * 合并结果整体验证：名称唯一、容量/瓦数为正、Cue 与接线引用完整。
 * 返回违规说明数组（空数组 = 通过）；任一违规则整次提交必须拒绝。
 */
function validateMerged(merged) {
  const violations = [];

  const checkNames = (kind) => {
    const byName = new Map();
    for (const e of merged[COLL_OF[kind]].values()) {
      if (typeof e.name !== 'string' || !/\S/.test(e.name)) {
        violations.push(`${KIND_LABEL[kind]} #${e.id} 名称不能为空`);
        continue;
      }
      const list = byName.get(e.name) || [];
      list.push(e.id);
      byName.set(e.name, list);
    }
    for (const [name, ids] of byName) {
      if (ids.length > 1) {
        violations.push(`${KIND_LABEL[kind]}名称「${name}」重复（编号 ${ids.map((i) => `#${i}`).join('、')}）`);
      }
    }
  };
  checkNames('light');
  checkNames('circuit');

  for (const c of merged.circuits.values()) {
    if (!(typeof c.capacity === 'number' && c.capacity > 0)) {
      violations.push(`回路 #${c.id} 容量必须为正数（当前 ${JSON.stringify(c.capacity)}）`);
    }
  }

  for (const [lightId, w] of [...merged.wirings.entries()].sort((a, b) => a[0] - b[0])) {
    if (!merged.lights.has(lightId)) {
      violations.push(`灯具 #${lightId} 的接线存在，但该灯具不在合并结果中`);
      continue;
    }
    if (w.circuit_id === null || w.circuit_id === undefined) {
      if (w.watts !== null && w.watts !== undefined) {
        violations.push(`灯具 #${lightId} 未分配回路，不能保留额定瓦数`);
      }
    } else {
      if (!merged.circuits.has(w.circuit_id)) {
        violations.push(`灯具 #${lightId} 的接线引用了不存在的回路 #${w.circuit_id}`);
      }
      if (!(typeof w.watts === 'number' && w.watts > 0)) {
        violations.push(`灯具 #${lightId} 已分配回路，额定瓦数必须为正数`);
      }
    }
  }

  const cueNos = new Set();
  for (const c of [...merged.cues.values()].sort((a, b) => a.cue_no - b.cue_no)) {
    if (!Number.isInteger(c.cue_no) || c.cue_no <= 0) {
      violations.push(`Cue 编号 ${JSON.stringify(c.cue_no)} 必须为正整数`);
    }
    if (cueNos.has(c.cue_no)) violations.push(`Cue 编号 ${c.cue_no} 重复`);
    cueNos.add(c.cue_no);
    if (!merged.lights.has(c.light_id)) {
      violations.push(`Cue #${c.cue_no} 引用了不存在的灯具 #${c.light_id}`);
    }
    if (!(typeof c.time === 'number' && c.time >= 0)) {
      violations.push(`Cue #${c.cue_no} 时码必须为非负数字`);
    }
    if (!(typeof c.target === 'number' && c.target >= 0 && c.target <= 100)) {
      violations.push(`Cue #${c.cue_no} 目标亮度必须在 0～100 之间`);
    }
    if (!(typeof c.duration === 'number' && c.duration >= 0)) {
      violations.push(`Cue #${c.cue_no} 渐变时长必须为非负数字`);
    }
  }

  return violations;
}

module.exports = {
  stateFromDraft,
  stateFromVersion,
  stateToDraftRows,
  computeMergePlan,
  applyResolutions,
  validateMerged,
  fingerprint,
};
