const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentTestDb } = require('./helpers/agentTestDb');

function insertConfig(db, row) {
  db.prepare(
    `INSERT INTO ai_service_configs
      (id, service_type, base_url, api_key, model, priority, is_default, is_active, deleted_at, endpoint)
     VALUES (@id, @service_type, @base_url, @api_key, @model, @priority, @is_default, @is_active, @deleted_at, @endpoint)`
  ).run({
    deleted_at: null,
    endpoint: '/chat/completions',
    is_active: 1,
    is_default: 1,
    priority: 0,
    ...row,
  });
}

describe('agent model and skills', () => {
  it('uses the highest priority default text model without appending the chat endpoint', async () => {
    const { resolveTextModel } = await import('../src/mastra/model.mjs');
    const db = createAgentTestDb();

    assert.deepEqual(resolveTextModel(db), { ok: false, error: '请先在 AI 配置里添加文本模型' });

    insertConfig(db, {
      id: 2, service_type: 'text', base_url: 'https://low.example/v1', api_key: 'sk-low', model: 'low-model', priority: 1,
    });
    insertConfig(db, {
      id: 1, service_type: 'text', base_url: 'https://example.test/v1/', api_key: 'sk-test', model: 'from-priority', priority: 5,
    });
    insertConfig(db, {
      id: 3, service_type: 'text', base_url: 'https://dead.example/v1', api_key: 'sk-dead', model: 'dead', priority: 99, deleted_at: '2026-01-01',
    });
    insertConfig(db, {
      id: 4, service_type: 'text', base_url: 'https://off.example/v1', api_key: 'sk-off', model: 'off', priority: 98, is_active: 0,
    });

    const picked = resolveTextModel(db);
    assert.equal(picked.ok, true);
    assert.equal(picked.model.id, 'custom/from-priority');
    assert.equal(picked.model.url, 'https://example.test/v1');
    assert.equal(picked.model.api, 'chat');
    assert.equal(picked.model.apiKey, 'sk-test');
    assert.equal('endpoint' in picked.model, false);

    const empty = createAgentTestDb();
    insertConfig(empty, {
      id: 1, service_type: 'text', base_url: '  ', api_key: 'sk', model: 'qwen', priority: 1,
    });
    assert.equal(resolveTextModel(empty).error, '文本模型的 base_url 或模型名为空');
  });

  it('skips invalid skill directories and keeps valid ones', async () => {
    const { listSkillDirectories } = await import('../src/mastra/skills.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-skills-'));
    const builtin = path.join(root, 'builtin');
    const user = path.join(root, 'user');
    fs.mkdirSync(path.join(user, 'ok'), { recursive: true });
    fs.mkdirSync(path.join(user, 'nope'), { recursive: true });
    fs.mkdirSync(builtin);
    fs.writeFileSync(path.join(user, 'ok', 'SKILL.md'), 'ok skill');
    fs.writeFileSync(path.join(user, 'nope', 'SKILL.md'), 'nope skill');
    const warnings = [];
    const dirs = listSkillDirectories({
      builtinDir: builtin,
      userSkillsDir: user,
      log: { warn(msg) { warnings.push(msg); } },
      validate(markdown) {
        if (String(markdown).includes('throw')) throw new Error('bad');
        return { valid: String(markdown).includes('ok') };
      },
    });
    assert.deepEqual(dirs, [path.resolve(path.join(user, 'ok'))]);
    assert.equal(warnings.length, 1);

    fs.writeFileSync(path.join(user, 'nope', 'SKILL.md'), 'throw please');
    const warnings2 = [];
    listSkillDirectories({
      builtinDir: builtin,
      userSkillsDir: user,
      log: { warn() { warnings2.push(1); } },
      validate(markdown) {
        if (String(markdown).includes('throw')) throw new Error('bad');
        return { valid: true };
      },
    });
    assert.equal(warnings2.length, 1);
  });
});
