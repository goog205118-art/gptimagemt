import test from 'node:test';
import assert from 'node:assert/strict';
import { agentImageSpecs, imagePromptLines, normalizeVariants, normalizeVariationSuggestions, hasBatchInstruction, assertSingleImagePrompt, normalizeCompiledVariants, variantBrief } from '../shared/agent-variants.js';
import { normalizePlan } from '../shared/agent-protocol.js';
import { captureRequirements, planSignature, requirementConflicts } from '../shared/agent-requirements.js';
import { recoverAgentSession } from '../src/core/agent-session.js';

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

test('screenshot regression: 创作3张 and batch lists are rejected without stripping creative meaning', () => {
  for (const prompt of [
    '创作3张独立横版高端消费电子产品海报，不要拼成一张。借鉴 Apple 广告的极简视觉语言',
    '创作３张独立横版高端消费电子产品海报',
    '做三张海报', '三张独立横版海报', '创作三套方案',
    '第一张：灰底。第二张：黑底。第三张：人像。',
    '方案一：白底\n方案二：黑底',
    'Make three separate product posters',
    'Create three premium consumer electronics posters',
  ]) {
    assert.equal(hasBatchInstruction(prompt), true, prompt);
    assert.throws(() => assertSingleImagePrompt(prompt), /阻止发送/);
  }
  for (const prompt of ['参考三张图片设计一张海报', '生成一张使用三张参考图的海报', '画面中摆放三个产品，英文排版', '使用三点布光，保持产品结构']) assert.equal(hasBatchInstruction(prompt), false, prompt);
});

test('compiled prompts are standalone sources, never prefixed with a shared brief or sibling deltas', () => {
  const brief = variantBrief(plan, '保持产品，仅变化光线');
  const result = { variants: variants.map((v) => ({ label: v.label, prompt: `一幅横版产品广告，保留结构和英文排版；${v.prompt}` })) };
  const compiled = normalizeCompiledVariants(result, { brief, maxPrompt: 32000 });
  const batchBrief = '创作3张独立横版高端消费电子产品海报，不要拼成一张';
  const discussion = normalizePlan({ ...plan, prompt: batchBrief }, { ...context, independentVariantPrompts: true });
  assert.equal(discussion.variantPromptMode, 'brief');
  assert.throws(() => agentImageSpecs(discussion), /简报尚未/);
  const specs = agentImageSpecs({ ...plan, prompt: batchBrief, variantPromptMode: 'complete', variants: compiled });
  specs.forEach((spec, i) => {
    assert.equal(spec.prompt, compiled[i].prompt);
    assert.equal(spec.variant, '');
    assert.equal(spec.variantLabel, variants[i].label);
    const sent = imagePromptLines(spec).join('\n');
    assert.ok(!sent.includes(batchBrief));
    assert.ok(!sent.includes('本张变化'));
    variants.forEach((v, j) => { if (i !== j) assert.ok(!sent.includes(v.prompt)); });
  });
  assert.throws(() => normalizeCompiledVariants({ variants: compiled.slice(1) }, { brief, maxPrompt: 32000 }), /数量/);
  assert.throws(() => normalizeCompiledVariants({ variants: compiled.toReversed() }, { brief, maxPrompt: 32000 }), /顺序/);
  assert.throws(() => normalizeCompiledVariants(result, { brief, maxPrompt: 5 }), /超过/);
  assert.throws(() => normalizeCompiledVariants({ variants: [{ ...compiled[0], prompt: '创作3张独立海报' }, ...compiled.slice(1)] }, { brief, maxPrompt: 32000 }), /本张变化/);
  assert.notEqual(planSignature(plan), planSignature({ ...plan, variantPromptMode: 'complete' }));
  assert.notDeepEqual(brief, variantBrief(plan, '更大胆的背景'));
});

test('interrupting prompt writing discards old compiled output without starting or resuming image requests', () => {
  const run = { id: 'run', status: 'review', variantWriting: true, variantCompilation: { variants }, requests: 0 };
  recoverAgentSession(run, []);
  assert.equal(run.status, 'review');
  assert.equal(run.requests, 0);
  assert.equal(run.variantWriting, undefined);
  assert.equal(run.variantCompilation, undefined);
  assert.match(run.error, /尚未发起生图/);
  const rawText = '  Soap Kit.\nHands-free.  ';
  assert.equal(captureRequirements({ settings: {}, refs: [], exactText: rawText }, '做变体').values.exactText, rawText);
});
