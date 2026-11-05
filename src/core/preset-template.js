const pattern = /\{\{([^{}\r\n]{1,60})\}\}|\[([^\[\]\r\n]{1,60})\]/g;

export function presetVariables(prompt, negative = '') {
  return [
    ...new Set(
      Array.from((prompt + '\n' + negative).matchAll(pattern), (match) =>
        (match[1] || match[2]).trim(),
      ),
    ),
  ];
}

export function renderPresetPrompt(preset, values = {}, includeNegative = true) {
  const replace = (text) =>
    String(text || '').replace(pattern, (original, a, b) => {
      const name = (a || b).trim();
      return Object.hasOwn(values, name) ? String(values[name]) : original;
    });
  const prompt = replace(preset.prompt),
    negative = includeNegative ? replace(preset.negative).trim() : '';
  return prompt.trim() + (negative ? '\n\n请避免以下内容：\n' + negative : '');
}
