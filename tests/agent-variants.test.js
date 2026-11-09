import test from 'node:test';
import assert from 'node:assert/strict';
import { agentImageSpecs, imagePromptLines, normalizeVariants, normalizeVariationSuggestions } from '../shared/agent-variants.js';
import { normalizePlan } from '../shared/agent-protocol.js';
import { captureRequirements, planSignature, requirementConflicts } from '../shared/agent-requirements.js';

const variants = [
  { label: '柔和侧光', prompt: '采用柔和左侧光，亮部略暖' },
  { label: '正面漫射光', prompt: '采用正面漫射光，减少阴影' },
  { label: '轻微轮廓光', prompt: '采用轻微轮廓光，边缘更清晰' },
];
const plan = {
  decision: 'ready', summary: '三张独立海报，仅调整光线', operation: 'create', baseId: '',
  prompt: '横版产品广告海报，保持产品形状与英文排版', constraints: 'Logo 保持原样', exactText: '  Your world.  ',
  count: 3, variantAxis: '光线', variants, model: 'gpt-image-2', size: '1536x1024', quality: 'medium',
  format: 'png', background: 'auto', referenceRoles: [], questions: [],
};
const context = {
  maxRequests: 3, references: [], currentSettings: { background: 'auto' },
  availableModels: [{ id: plan.model, sizes: [plan.size], qualities: [plan.quality], maxPrompt: 32000 }],
};
test('each variant contains only its own delta and the shared single-image brief', () => {
  const normalized = normalizePlan(plan, context);
  const specs = agentImageSpecs(normalized);
  assert.equal(specs.length, 3);
  specs.forEach((spec, i) => {
    const prompt = imagePromptLines(spec).join('\n');
    assert.ok(prompt.includes('只生成一张'));
    assert.ok(prompt.includes(plan.prompt));
    assert.ok(prompt.includes(variants[i].prompt));
    assert.ok(!prompt.includes('三张独立海报'));
    variants.forEach((other, j) => { if (i !== j) assert.ok(!prompt.includes(other.prompt)); });
    assert.equal(spec.variantAxis, '光线');
    assert.equal(spec.variantIndex, i);
  });
  assert.equal(normalized.exactText, '  Your world.  ');
});
test('legacy aggregate prompts and missing, duplicate or extra variants are blocked before enqueue', () => {
  for (const prompt of [
    '生成三张独立的横版高级产品广告海报，每张都是完整设计',
    '生成 3 张产品海报，三张分别使用不同背景',
    'Create three independent landscape product posters',
    'Generate a set of three separate posters',
  ]) assert.throws(() => normalizeVariants({ ...plan, prompt }), /整批/);
  assert.throws(() => normalizeVariants({ ...plan, variants: undefined }), /每张/);
  assert.throws(() => normalizeVariants({ ...plan, variants: variants.slice(0, 2) }), /每张/);
  assert.throws(() => normalizeVariants({ ...plan, variants: [variants[0], variants[0], variants[2]] }), /重复/);
  assert.throws(() => normalizeVariants({ ...plan, variantAxis: '' }), /变化维度/);
  assert.throws(() => normalizeVariants({ ...plan, variants: [variants[0], variants[1], { label: '混合', prompt: '生成三张图片' }] }), /本张变化/);
});
test('single-image legacy plans remain usable and changing any variant invalidates approval', () => {
  assert.equal(agentImageSpecs({ ...plan, count: 1, variantAxis: undefined, variants: undefined }).length, 1);
  assert.throws(() => normalizeVariants({ ...plan, count: 1 }), /数量/);
  assert.equal(agentImageSpecs({ ...plan, count: 1, variants: [variants[1]] })[0].variant, variants[1].prompt);
  assert.notEqual(planSignature(plan), planSignature({ ...plan, variants: [{ ...variants[0], prompt: '提高亮度' }, ...variants.slice(1)] }));
  assert.notEqual(planSignature(plan), planSignature({ ...plan, variantAxis: '背景' }));
  assert.throws(() => agentImageSpecs({ ...plan, count: 0 }), /张数/);
  assert.equal(agentImageSpecs({ ...plan, count: 1, variants: [], prompt: '生成一张使用三张参考图的产品海报' }).length, 1);
});
test('content-aware recommendations need reasons and distinct single-image options before user selection', () => {
  const groups = [{ axis: '光线', reason: '产品表面有纹理，调整光向可比较材质表现，保持主体与英文排版。', variants }];
  assert.deepEqual(normalizeVariationSuggestions(groups), groups);
  assert.throws(() => normalizeVariationSuggestions([{ ...groups[0], reason: '' }]), /理由/);
  assert.throws(() => normalizeVariationSuggestions([{ ...groups[0], variants: [variants[0], variants[0]] }]), /重复/);
  assert.throws(() => normalizeVariationSuggestions([groups[0], groups[0]]), /维度不能重复/);
  assert.throws(() => normalizePlan(plan, { ...context, variationRecommendationsRequired: true }), /变化建议/);
  assert.equal(normalizePlan({ ...plan, contentType: '产品广告海报', variationSuggestions: groups }, { ...context, variationRecommendationsRequired: true }).contentType, '产品广告海报');
});
test('explicit variation axis and lines are preserved as user requirements', () => {
  const requirements = captureRequirements({ settings: {}, refs: [], variantAxis: '光线', variants: variants.map((v) => v.prompt).join('\n') }, '做几个变体');
  assert.deepEqual(requirementConflicts(plan, requirements), []);
  assert.ok(requirementConflicts({ ...plan, variantAxis: '背景' }, requirements).some((issue) => issue.field === 'variantAxis'));
  assert.ok(requirementConflicts({ ...plan, variants: [...variants].reverse() }, requirements).some((issue) => issue.field === 'variants'));
});
