import test from 'node:test';
import assert from 'node:assert/strict';
import { presetVariables, renderPresetPrompt } from '../src/core/preset-template.js';
import { PROMPT_PRESET_SEEDS } from '../src/data/prompt-presets.js';

test('template fields support both syntaxes, deduplicate names and replace literal values safely', () => {
  const prompt = 'A [主体] on {{背景}}, another [主体].';
  assert.deepEqual(presetVariables(prompt), ['主体', '背景']);
  assert.equal(
    renderPresetPrompt({ prompt }, { 主体: '$& mug', 背景: 'wood' }),
    'A $& mug on wood, another $& mug.',
  );
  assert.equal(renderPresetPrompt({ prompt: '[未填写]' }), '[未填写]');
});

test('avoid instructions are optional natural language and notes are never submitted', () => {
  const preset = {
    prompt: 'Photograph [主体].',
    negative: 'watermark, [不需要]',
    notes: '--ar 16:9',
  };
  assert.equal(
    renderPresetPrompt(preset, { 主体: 'cup', 不需要: 'blur' }),
    'Photograph cup.\n\n请避免以下内容：\nwatermark, blur',
  );
  assert.equal(renderPresetPrompt(preset, { 主体: 'cup' }, false), 'Photograph cup.');
});

test('all ten supplied templates retain positive and negative content without platform switches', () => {
  assert.equal(PROMPT_PRESET_SEEDS.length, 10);
  assert.equal(new Set(PROMPT_PRESET_SEEDS.map((preset) => preset.id)).size, 10);
  for (const preset of PROMPT_PRESET_SEEDS) {
    assert.ok(preset.name && preset.category && preset.prompt && preset.negative);
    assert.equal(/--ar|--style|--s\b/.test(preset.prompt), false);
  }
});
