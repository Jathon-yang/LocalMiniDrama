const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveArkTextModel, applyVolcChatOptions } = require('../src/services/aiClient');
const { normalizeVolcModel } = require('../src/services/videoClient');
const { resolveDashScopeImageModel } = require('../src/services/imageClient');

const ark = { base_url: 'https://ark.cn-beijing.volces.com/api/v3', provider: 'volcengine' };
const relay = { base_url: 'https://api.example.com/v1', provider: 'volcengine' };
const dashscope = { base_url: 'https://dashscope.aliyuncs.com', provider: 'qwen_image' };

const retiredTextList = '["deepseek-v3-2-251201","doubao-1-5-pro-32k-250115","kimi-k2-thinking-251104"]';

test('official Ark text presets replace retired DeepSeek 3.2 and old Doubao/Kimi ids', () => {
  assert.equal(resolveArkTextModel(ark, 'deepseek-v3-2-251201'), 'deepseek-v4-flash-ga-260731');
  assert.equal(resolveArkTextModel(ark, 'doubao-1-5-pro-32k-250115'), 'doubao-seed-2-1-lite-260915');
  assert.equal(resolveArkTextModel(ark, 'kimi-k2-thinking-251104'), 'doubao-seed-2-1-lite-260915');
  assert.equal(resolveArkTextModel(ark, retiredTextList), 'deepseek-v4-flash-ga-260731');
  assert.equal(resolveArkTextModel(ark, JSON.parse(retiredTextList)), 'deepseek-v4-flash-ga-260731');
  assert.equal(resolveArkTextModel(relay, 'deepseek-v3-2-251201'), 'deepseek-v3-2-251201');
  assert.equal(resolveArkTextModel(relay, retiredTextList), 'deepseek-v3-2-251201');
});

test('Ark DeepSeek V4 and Seed 2 chat calls disable thinking unless already set', () => {
  const body = applyVolcChatOptions(ark, { model: 'deepseek-v3-2-251201', messages: [] });
  assert.equal(body.model, 'deepseek-v4-flash-ga-260731');
  assert.deepEqual(body.thinking, { type: 'disabled' });

  const fromList = applyVolcChatOptions(ark, { model: retiredTextList, messages: [] });
  assert.equal(fromList.model, 'deepseek-v4-flash-ga-260731');
  assert.deepEqual(fromList.thinking, { type: 'disabled' });

  const kept = applyVolcChatOptions(ark, {
    model: 'doubao-seed-2-1-lite-260915',
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(kept.thinking, { type: 'enabled' });
  assert.equal(applyVolcChatOptions(relay, { model: 'deepseek-v4-flash-ga-260731' }).thinking, undefined);
});

test('official Ark video replaces retired Seedance 1.5, relays keep the stored id', () => {
  assert.equal(
    normalizeVolcModel('doubao-seedance-1-5-pro-251215', ark),
    'doubao-seedance-2-0-fast-260128'
  );
  assert.equal(
    normalizeVolcModel('doubao-seedance-1.5-pro', ark),
    'doubao-seedance-2-0-fast-260128'
  );
  assert.equal(
    normalizeVolcModel('doubao-seedance-1-5-pro-251215', relay),
    'doubao-seedance-1-5-pro-251215'
  );
});

test('official DashScope replaces retired qwen-image model ids', () => {
  assert.equal(resolveDashScopeImageModel(dashscope, 'qwen-image-max'), 'qwen-image-3.0');
  assert.equal(resolveDashScopeImageModel(dashscope, 'qwen-image-plus'), 'qwen-image-3.0');
  assert.equal(resolveDashScopeImageModel(dashscope, 'qwen-image'), 'qwen-image-3.0');
  assert.equal(resolveDashScopeImageModel(dashscope, 'wan2.6-image'), 'wan2.6-image');
  assert.equal(resolveDashScopeImageModel(relay, 'qwen-image-max'), 'qwen-image-max');
});
