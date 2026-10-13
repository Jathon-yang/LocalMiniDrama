const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const svc = require('../src/services/episodeStoryboardService');

const noopLog = { info() {}, warn() {}, error() {} };

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, style TEXT, metadata TEXT, deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER, title TEXT, script_content TEXT, description TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER,
      title TEXT, description TEXT, location TEXT, time TEXT, duration INTEGER,
      dialogue TEXT, narration TEXT, action TEXT, result TEXT, atmosphere TEXT,
      image_prompt TEXT, video_prompt TEXT, characters TEXT,
      shot_type TEXT, angle TEXT, angle_h TEXT, angle_v TEXT, angle_s TEXT,
      movement TEXT, lighting_style TEXT, depth_of_field TEXT,
      segment_index INTEGER, segment_title TEXT, creation_mode TEXT,
      universal_segment_text TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER, name TEXT, role TEXT, description TEXT, personality TEXT,
      appearance TEXT, image_url TEXT, local_path TEXT, sort_order INTEGER,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboard_characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER, character_id INTEGER
    );
    CREATE TABLE storyboard_props (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER, prop_id INTEGER
    );
  `);
  return db;
}

/** 种子：1 部剧 / 1 集 / 1 个角色（林薇）/ 1 个分镜 */
function seedStoryboard(db, { charactersJson = JSON.stringify([{ id: 1, name: '林薇' }]), appearance = '素色连衣裙，丸子头' } = {}) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, style, metadata) VALUES (1, ?, ?, NULL)').run('测试剧', '动漫');
  db.prepare('INSERT INTO episodes (id, drama_id, title, script_content) VALUES (1, 1, ?, ?)').run('第1集', '林薇回到老宅。');
  db.prepare('INSERT INTO characters (id, drama_id, name, appearance) VALUES (1, 1, ?, ?)').run('林薇', appearance);
  db.prepare(
    `INSERT INTO storyboards (id, episode_id, storyboard_number, title, action, characters, created_at, updated_at)
     VALUES (1, 1, 1, '开场', '林薇走进房间', ?, ?, ?)`
  ).run(charactersJson, now, now);
}

describe('#38 角色造型注入视频提示词', () => {
  it('rebuildVideoPromptForStoryboard 正常返回且 video_prompt 含角色造型', () => {
    const db = createTestDb();
    seedStoryboard(db);
    const sb = svc.rebuildVideoPromptForStoryboard(db, noopLog, 1);
    assert.ok(sb, '应返回更新后的分镜');
    assert.match(sb.video_prompt, /角色造型：/);
    assert.match(sb.video_prompt, /「林薇」素色连衣裙，丸子头/);
  });

  it('角色无造型信息时不注入角色造型段', () => {
    const db = createTestDb();
    seedStoryboard(db, { appearance: '' });
    const sb = svc.rebuildVideoPromptForStoryboard(db, noopLog, 1);
    assert.ok(sb);
    assert.doesNotMatch(sb.video_prompt, /角色造型：/);
  });

  it('characters JSON 为空时回退 storyboard_characters 关联表', () => {
    const db = createTestDb();
    seedStoryboard(db, { charactersJson: '[]' });
    db.prepare('INSERT INTO storyboard_characters (storyboard_id, character_id) VALUES (1, 1)').run();
    const sb = svc.rebuildVideoPromptForStoryboard(db, noopLog, 1);
    assert.match(sb.video_prompt, /「林薇」素色连衣裙，丸子头/);
  });

  it('composeStoryboardVideoPrompt 有 character_appearances 时输出角色造型段', () => {
    const prompt = svc.composeStoryboardVideoPrompt(
      { title: '开场', action: '林薇走进房间', character_appearances: '「林薇」素色连衣裙，丸子头' },
      '动漫',
      '16:9'
    );
    assert.match(prompt, /角色造型：「林薇」素色连衣裙，丸子头/);
  });

  it('deriveStoryboardFieldsFromAi 经 characterAppearances 映射注入造型', () => {
    const map = { '1': '「林薇」素色连衣裙，丸子头', 'name:林薇': '「林薇」素色连衣裙，丸子头' };
    const d = svc.deriveStoryboardFieldsFromAi(
      { title: '开场', action: '林薇走进房间', characters: [{ id: 1, name: '林薇' }] },
      '动漫',
      '16:9',
      { characterAppearances: map }
    );
    assert.match(d.videoPrompt, /角色造型：「林薇」素色连衣裙，丸子头/);
  });

  it('deriveStoryboardFieldsFromAi 无映射时不注入（保持原行为）', () => {
    const d = svc.deriveStoryboardFieldsFromAi(
      { title: '开场', action: '林薇走进房间', characters: [{ id: 1, name: '林薇' }] },
      '动漫',
      '16:9',
      {}
    );
    assert.doesNotMatch(d.videoPrompt, /角色造型：/);
  });

  it('saveStoryboards 经 deriveOpts 入库的 video_prompt 含角色造型', () => {
    const db = createTestDb();
    seedStoryboard(db, { charactersJson: '[]' });
    svc.saveStoryboards(
      db,
      noopLog,
      1,
      [{ shot_number: 1, title: '开场', action: '林薇走进房间', characters: [{ id: 1, name: '林薇' }] }],
      { style: {} },
      '动漫',
      null,
      { characterAppearances: { '1': '「林薇」素色连衣裙，丸子头', 'name:林薇': '「林薇」素色连衣裙，丸子头' } }
    );
    const row = db.prepare('SELECT video_prompt FROM storyboards WHERE episode_id = 1 AND deleted_at IS NULL').get();
    assert.match(row.video_prompt, /角色造型：「林薇」素色连衣裙，丸子头/);
  });
});
