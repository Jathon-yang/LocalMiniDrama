const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const promptI18n = require('../src/services/promptI18n');

/** 标准化：去掉所有 ${...} 插值、UI 占位符 [xxx]、空白，用于字面比较 */
function normalize(s) {
  return s
    .replace(/\$\{[^}]+\}/g, '占位')
    .replace(/\[[^\]]+\]/g, '占位')
    .replace(/\s+/g, '');
}

describe('#28 promptI18n.js 默认提示词与运行时提示词字面一致', () => {
  it('character_extraction：default body 中第 3 条与 runtime 默认段字面一致', () => {
    const defaultBody = promptI18n.getDefaultPromptBody('character_extraction');
    const runtime = promptI18n.getCharacterExtractionPrompt({ app: { language: 'zh' } });
    // 抽取 "3. 主要角色..." 这一条
    const m1 = defaultBody.match(/3\.[^]*?(?=\n\n|$)/);
    const m2 = runtime.match(/3\.[^]*?(?=\n-|输出格式|$)/s);
    assert.ok(m1 && m2, '应能在两边都抽出第 3 条');
    assert.equal(normalize(m1[0]), normalize(m2[0]),
      `第 3 条字面应一致\ndefault: ${m1[0]}\nruntime: ${m2[0]}`);
  });

  it('character_extraction：default 中"次要角色可简化"与 runtime 表述一致', () => {
    const defaultBody = promptI18n.getDefaultPromptBody('character_extraction');
    const runtime = promptI18n.getCharacterExtractionPrompt({ app: { language: 'zh' } });
    assert.match(defaultBody, /次要角色可简化/);
    assert.match(runtime, /次要角色可简化/);
    assert.doesNotMatch(defaultBody, /次要角色可以简化/);
    assert.doesNotMatch(runtime, /次要角色可以简化/);
  });

  it('prop_extraction：default 第 3 条与 runtime 表述一致（仅/禁止）', () => {
    const defaultBody = promptI18n.getDefaultPromptBody('prop_extraction');
    const runtime = promptI18n.getPropExtractionPrompt({ app: { language: 'zh' } });
    // default 第 3 条
    const m1 = defaultBody.match(/3\.[^]*?(?=\n4\.|$)/s);
    const m2 = runtime.match(/3\.[^]*?(?=\n4\.|$)/s);
    assert.ok(m1 && m2);
    assert.equal(normalize(m1[0]), normalize(m2[0]),
      `prop_extraction 第 3 条字面应一致\ndefault: ${m1[0]}\nruntime: ${m2[0]}`);
  });

  it('prop_extraction：default 不再用"只"和"不要"，runtime 同样如此', () => {
    const defaultBody = promptI18n.getDefaultPromptBody('prop_extraction');
    const runtime = promptI18n.getPropExtractionPrompt({ app: { language: 'zh' } });
    // 第 3 条里应该用 "仅" 和 "禁止"
    const line3Default = defaultBody.split('\n').find((l) => l.startsWith('3.')) || '';
    const line3Runtime = runtime.split('\n').find((l) => l.startsWith('3.')) || '';
    assert.match(line3Default, /\*\*仅\*\*/);
    assert.match(line3Default, /\*\*禁止\*\*/);
    assert.match(line3Runtime, /\*\*仅\*\*/);
    assert.match(line3Runtime, /\*\*禁止\*\*/);
  });
});
