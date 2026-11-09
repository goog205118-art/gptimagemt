// Batch orchestration belongs to the plan, never to a single image request.
export function hasBatchInstruction(value) {
  const source = String(value || '').normalize('NFKC');
  const count = '(?:[2-9]\\d*|1\\d+|[二两三四五六七八九十]+)';
  const unit = '(?:张|幅|个|款|套)';
  const output = '(?:海报|图片|图像|广告|方案|变体|设计|主图|图)';
  return new RegExp(`(?:创作|生成|制作|设计|输出|绘制|交付|做出|做|出图)[^。；\\n]{0,12}${count}\\s*${unit}(?!\\s*(?:参考|素材|输入))[^。；\\n]{0,32}${output}`).test(source) ||
    new RegExp(`${count}\\s*(?:张|幅|款)(?:独立|完整|分别|各自|各为|分为)`).test(source) ||
    new RegExp(`${count}\\s*(?:套|款|个)\\s*(?:独立|不同|完整)?\\s*(?:方案|变体|海报|广告|设计)`).test(source) ||
    /(?:第[一1]张|方案[一1]|变体[一1])[\s\S]*(?:第[二2]张|方案[二2]|变体[二2])/.test(source) ||
    /(?:generate|create|render|produce|design|make)\s*:?\s+(?:(?:a\s+)?(?:set|batch|series)\s+of\s+)?(?:[2-9]\d*|1\d+|two|three|four|five|six|seven|eight)\s+(?:(?:separate|independent|different|complete|landscape|product|horizontal|premium|consumer|electronics?)\s+)*(?:images?|posters?|variants?|designs?|ads?)\b/i.test(source);
}

export function assertSingleImagePrompt(value) {
  if (hasBatchInstruction(value)) throw new Error('提示词仍含整批创作或多方案指令，已阻止发送。请让 AI 重新编写每张独立提示词。');
}

export function normalizeVariants(plan) {
  if (!Number.isInteger(plan.count) || plan.count < 1 || plan.count > 3) throw new Error('交付张数需为 1–3 张。');
  const text = (value, max, label) => {
    if (typeof value !== 'string' || value.length > max || !value.trim()) throw new Error(`${label}不能为空或过长。`);
    return value.trim();
  };
  if ((!['brief', 'complete'].includes(plan.variantPromptMode) && hasBatchInstruction(plan.prompt || '')) || hasBatchInstruction(plan.constraints || ''))
    throw new Error('单张创作要求仍含整批生成指令，请重新规划：共同要求只描述一张图，各张差异分别填写。');
  const variants = plan.variants ?? [];
  if (!Array.isArray(variants)) throw new Error('逐张变体方案格式无效，请重新规划。');
  if (plan.count === 1) {
    if (!variants.length) return { variantAxis: '', variants: [] };
  }
  if (variants.length !== plan.count) throw new Error('每张图片必须有独立的变体方案，数量需与交付张数相同；旧方案请重新规划。');
  const variantAxis = text(plan.variantAxis, 100, '变化维度');
  const normalized = variants.map((variant) => {
    const label = text(variant?.label, 100, '变体名称');
    const prompt = text(variant?.prompt, 4000, '本张变化');
    if (hasBatchInstruction(prompt)) throw new Error('本张变化只能描述当前这一张，不能包含整批或其他图片的生成指令。');
    return { label, prompt };
  });
  if (new Set(normalized.map((v) => v.prompt.toLowerCase().replace(/\s+/g, ''))).size !== plan.count)
    throw new Error('变体内容重复，请在变化维度内分别填写有区别的适度变化。');
  return { variantAxis, variants: normalized };
}

export function agentImageSpecs(plan) {
  const { variantAxis, variants } = normalizeVariants(plan);
  if (plan.variantPromptMode === 'brief') throw new Error('创作简报尚未编写成每张独立提示词，不能作为生图请求。');
  if (!variants.length) return [{ prompt: plan.prompt, variant: '', variantAxis: '', variantLabel: '', variantIndex: 0, variantCount: 1 }];
  return variants.map((variant, i) => ({
    prompt: plan.variantPromptMode === 'complete' ? variant.prompt : plan.prompt,
    variant: plan.variantPromptMode === 'complete' ? '' : variant.prompt,
    variantPromptMode: plan.variantPromptMode || 'delta', variantAxis, variantLabel: variant.label,
    variantIndex: i, variantCount: plan.count,
  }));
}

export function imagePromptLines(task) {
  const lines = [];
  if (task.variantCount > 1 || task.variant || task.variantPromptMode === 'complete')
    lines.push('本次请求只生成一张完整、独立的图片。不要将多个方案拼成合并图、三联图、分屏或联系表。');
  lines.push(task.prompt);
  if (task.variant) lines.push(`本张变化（${task.variantAxis || '变化'}）：${task.variant}。只在此维度内做适度变化；未明确指定变化的主体、文案和结构保持一致，始终遵守共同保留要求。`);
  return lines;
}

// The source of truth is the selected brief, never a batch summary or a prior compilation.
export function variantBrief(plan, styleNotes = '') {
  return {
    prompt: plan.prompt, constraints: plan.constraints, exactText: plan.exactText,
    contentType: plan.contentType, operation: plan.operation, baseId: plan.baseId,
    model: plan.model, size: plan.size, quality: plan.quality, format: plan.format,
    background: plan.background, referenceRoles: plan.referenceRoles,
    variantAxis: plan.variantAxis, variants: plan.variants.map(({ label, prompt }) => ({ label, prompt })),
    styleNotes: styleNotes.trim(),
  };
}

export function normalizeCompiledVariants(result, context) {
  const brief = context.brief;
  if (!brief || !Array.isArray(brief.variants) || !brief.variants.length || brief.variants.length > 3)
    throw new Error('请先选择 1–3 个变化细节。');
  const normalized = normalizeVariants({ count: brief.variants.length, variantAxis: brief.variantAxis, variants: result?.variants });
  const maxPrompt = context.maxPrompt;
  if (!Number.isInteger(maxPrompt) || maxPrompt < 1 || maxPrompt > 100000) throw new Error('提示词长度限制无效。');
  normalized.variants.forEach((variant, i) => {
    if (variant.label !== brief.variants[i].label) throw new Error('AI 返回的变体顺序或名称已改变，请重新编写。');
    if (variant.prompt.length > maxPrompt) throw new Error('独立提示词超过当前模型限制，请缩短后重写。');
  });
  return normalized.variants;
}

export function normalizeVariationSuggestions(groups) {
  if (groups == null) return [];
  if (!Array.isArray(groups) || groups.length > 3) throw new Error('推荐变化维度最多三组。');
  const normalizedGroups = groups.map((group) => {
    if (typeof group?.reason !== 'string' || !group.reason.trim() || group.reason.length > 500)
      throw new Error('推荐维度需要说明与当前内容相关的理由。');
    if (!Array.isArray(group.variants) || group.variants.length < 2 || group.variants.length > 3)
      throw new Error('每个推荐维度需提供 2–3 个变化细节。');
    const normalized = normalizeVariants({ count: group.variants.length, variantAxis: group.axis, variants: group.variants });
    return { axis: normalized.variantAxis, reason: group.reason.trim(), variants: normalized.variants };
  });
  if (new Set(normalizedGroups.map((group) => group.axis)).size !== normalizedGroups.length) throw new Error('推荐变化维度不能重复。');
  return normalizedGroups;
}
