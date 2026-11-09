export const SESSION_VERSION = 1;
export const OPERATIONS = { create: '新建', edit: '整图修改', local: '局部修改', crop: '本地裁切', outpaint: '扩图' };
export const FIELD_NAMES = { operation: '操作', baseId: '底图', count: '张数', size: '尺寸', ratio: '画幅', format: '格式', background: '背景', constraints: '保留要求', exactText: '精确文案', variantAxis: '变化维度' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// These conservative extractions are shown for confirmation. The original request
// remains authoritative; unrecognised language is never treated as a free pass.
export function captureRequirements(snapshot, request, inherited = null) {
  const values = {}, sources = {};
  const set = (key, value, source) => { values[key] = value; sources[key] = source; };
  for (const key of ['constraints', 'exactText'])
    if (inherited?.values?.[key]) set(key, inherited.values[key], { kind: 'version', versionId: snapshot.parentId, original: inherited.sources?.[key] });
  if (snapshot.constraints?.trim()) set('constraints', snapshot.constraints.trim(), { kind: 'user', text: snapshot.constraints });
  if (snapshot.exactText) set('exactText', snapshot.exactText, { kind: 'user', text: snapshot.exactText });
  const explicit = (key, value) => set(key, value, { kind: 'request', text: request });
  if (snapshot.variantAxis) set('variantAxis', snapshot.variantAxis, { kind: 'user', text: snapshot.variantAxis });
  const count = request.match(/(\d+|[一二两三四五六七八九])\s*张/);
  if (count) explicit('count', Number.isFinite(Number(count[1])) ? Number(count[1]) : ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })[count[1]]);
  const size = request.match(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/i);
  if (size) explicit('size', `${size[1]}x${size[2]}`);
  const ratio = request.match(/\b([1-9]\d?)\s*[:：]\s*([1-9]\d?)\b/);
  if (ratio) explicit('ratio', `${Number(ratio[1])}:${Number(ratio[2])}`);
  else if (/正方形|方图/.test(request)) explicit('ratio', '1:1');
  const format = request.match(/\b(png|jpeg|jpg|webp)\b/i);
  if (format) explicit('format', format[1].toLowerCase().replace('jpg', 'jpeg'));
  if (/透明背景/.test(request) || snapshot.settings.background === 'transparent') explicit('background', 'transparent');
  const preserve = request.split(/[，,。；;\n]/).filter((part) => /保持|保留|不变|不得|不要改变|不能改变/.test(part));
  if (preserve.length) explicit('constraints', [...new Set([values.constraints, ...preserve].filter(Boolean))].join('\n'));
  // Do not trim the quoted text: spaces, punctuation and case are data.
  const exact = [...request.matchAll(/[「“"]([^」”"\n]+)[」”"]/g)].map((m) => m[1]);
  if (exact.length && /文案|文字|逐字|英文|标题|写上|text|headline/i.test(request)) explicit('exactText', exact.join('\n'));
  const base = snapshot.refs.find((ref) => ref.role === 'base');
  if (base) set('baseId', base.id, { kind: 'user', versionId: base.versionId || snapshot.parentId });
  let operation = snapshot.mask ? (snapshot.mask.kind === 'outpaint' ? 'outpaint' : 'local') : snapshot.parentId || base ? 'edit' : null;
  if (/扩图|扩展画布|向.+补/.test(request)) operation = 'outpaint';
  else if (/局部|只[去改]|去除.+纹理/.test(request)) operation = 'local';
  else if (/裁切|裁剪/.test(request)) operation = 'crop';
  else if (/新建|重新创作/.test(request)) operation = 'create';
  if (operation) set('operation', operation, { kind: 'user', text: request });
  const references = snapshot.refs.map(({ id, role = 'general', note = '', userRole, userNote, versionId }, index) => {
    const numeral = ['一', '二', '三', '四', '五', '六', '七', '八', '九'][index];
    const clause = request.split(/[，,。；;\n]/).find((part) => new RegExp(`图\\s*(?:${index + 1}(?!\\d)${numeral ? '|' + numeral : ''})`).test(part));
    let explicitRole = userRole ?? role;
    if (clause) {
      if (/底图/.test(clause)) explicitRole = 'base';
      else if (/主体|产品/.test(clause)) explicitRole = 'subject';
      else if (/风格/.test(clause)) explicitRole = 'style';
      else if (/构图/.test(clause)) explicitRole = 'composition';
      else if (/色彩|配色/.test(clause)) explicitRole = 'palette';
    }
    return { id, role: explicitRole, note: userNote ?? [...new Set([note, clause].filter(Boolean))].join('；'), versionId: versionId || null, locked: !!clause || userRole != null || role !== 'general' || !!note };
  });
  return {
    version: SESSION_VERSION, values, sources, originalRequest: request,
    variationOptions: snapshot.variantAxis ? (snapshot.variants || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [],
    references,
    requiresReview: !!inherited && /Logo|标志|文案|文字|材质|结构|保留项/i.test(request) && /改|换|替换|去掉|删除|取消|不要|不再/.test(request),
    legacy: !!snapshot.parentId && !inherited,
  };
}

export function matchesRatio(size, ratio) {
  const [w, h] = String(size).split('x').map(Number), [a, b] = String(ratio).split(':').map(Number);
  return w > 0 && h > 0 && a > 0 && b > 0 && Math.abs(w / h - a / b) < 0.002;
}

export function requirementConflicts(plan, requirements) {
  if (!requirements) return [];
  const conflicts = [];
  const add = (field, expected, actual) => conflicts.push({ field, label: FIELD_NAMES[field] || field, expected, actual });
  for (const [key, expected] of Object.entries(requirements.values || {})) {
    if (key === 'constraints' || key === 'exactText') {
      if (String(expected).split('\n').some((line) => line && !String(plan[key] || '').includes(line))) add(key, expected, plan[key] || '');
    } else if (key === 'ratio') {
      if (!matchesRatio(plan.size, expected)) add(key, expected, plan.size);
    } else if (!same(plan[key], expected)) add(key, expected, plan[key]);
  }
  for (const ref of requirements.references || []) {
    const actual = plan.referenceRoles?.find((r) => r.id === ref.id);
    if (ref.locked && (!actual || actual.role !== ref.role || actual.note !== ref.note))
      conflicts.push({ field: `reference:${ref.id}`, label: '参考用途', expected: `${ref.role} · ${ref.note}`, actual: actual ? `${actual.role} · ${actual.note}` : '缺失' });
  }
  if (requirements.variationOptions?.length && (plan.variants?.length !== requirements.variationOptions.length || requirements.variationOptions.some((option, i) => !plan.variants?.[i]?.prompt?.includes(option))))
    conflicts.push({ field: 'variants', label: '逐张变化', expected: requirements.variationOptions.join('；'), actual: plan.variants?.map((variant) => variant.prompt).join('；') || '缺失' });
  return conflicts;
}

export function executionIssues(plan, snapshot) {
  const issues = [];
  if (!OPERATIONS[plan.operation]) issues.push('请选择有效操作。');
  const base = snapshot.refs.find((ref) => ref.id === plan.baseId);
  if (plan.operation !== 'create' && !base) issues.push('此操作需要明确选择一张底图。');
  if (plan.operation === 'create' && plan.baseId) issues.push('新建操作不能同时绑定编辑底图，请清空底图选择。');
  if (snapshot.refs.some((ref) => !(ref.blob instanceof Blob) || !ref.blob.size)) issues.push('底图或参考素材已失效，请重新添加。');
  if (snapshot.mask && (plan.baseId !== snapshot.mask.assetId || !['local', 'outpaint'].includes(plan.operation))) issues.push('操作或底图与现有蒙版冲突，请重新划选。');
  if (plan.operation === 'local' && (!snapshot.mask || snapshot.mask.kind === 'outpaint')) issues.push('请先划选需要修改的区域。');
  if (plan.operation === 'outpaint' && snapshot.mask?.kind !== 'outpaint') issues.push('请先确认扩图方向、留白和原图保留策略。');
  if (['crop', 'local', 'outpaint'].includes(plan.operation) && plan.count !== 1) issues.push('此操作本轮只交付一个版本，请将张数设为 1。');
  if (snapshot.mask && (plan.size !== `${snapshot.mask.width}x${snapshot.mask.height}` || (snapshot.mask.keepOutside !== false && plan.format !== 'png'))) issues.push('请使用蒙版画布尺寸；保护原图区域时必须使用 PNG。');
  return issues;
}

export function planSignature(plan) {
  return JSON.stringify(['operation', 'baseId', 'prompt', 'constraints', 'exactText', 'model', 'size', 'quality', 'format', 'background', 'count', 'referenceRoles', 'variantAxis', 'variants', 'variantPromptMode'].map((key) => plan[key] ?? null));
}

export function confirmedRequirements(run, plan) {
  const fields = ['operation', 'baseId', 'count', 'size', 'format', 'background', 'constraints', 'exactText'];
  const sources = Object.fromEntries(fields.map((key) => [key, {
    kind: 'confirmation', runId: run.id, revision: run.planRevision || 1,
    text: plan[key] ?? '', previous: run.requirements?.sources?.[key] || null,
  }]));
  return {
    ...structuredClone(run.requirements), version: SESSION_VERSION, confirmedAt: Date.now(),
    sources,
    values: Object.fromEntries(fields.map((key) => [key, plan[key] ?? ''])),
    references: plan.referenceRoles.map((ref) => ({ ...ref, locked: true, source: { kind: 'confirmation', runId: run.id } })),
  };
}

export function automaticEligible(run, plan, price, options) {
  return !!options.automatic && !!options.previouslyConfirmed && !run.requirements?.legacy && !run.requirements?.requiresReview &&
    !run.planConflicts?.length && !requirementConflicts(plan, run.requirements).length &&
    !executionIssues(plan, run.snapshot).length && run.costLimit !== null && price !== null &&
    plan.count * price <= run.costLimit && !['crop', 'local', 'outpaint'].includes(plan.operation) &&
    options.previousScope === automationScope(run, plan, price);
}

export function automationScope(run, plan, price) {
  return JSON.stringify([planSignature({ ...plan, prompt: '', constraints: '', exactText: '' }), price, run.currency, run.costLimit, run.maxRequests]);
}
