const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const videoClient = require('../src/services/videoClient');
const aiConfigService = require('../src/services/aiConfigService');

const originalListConfigs = aiConfigService.listConfigs;
const originalFetch = global.fetch;

function makeVolcengineConfig(overrides = {}) {
  return {
    id: 1,
    service_type: 'video',
    is_active: true,
    is_default: true,
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: 'test-key',
    model: ['doubao-seedance-2.5-260628'],
    default_model: 'doubao-seedance-2.5-260628',
    ...overrides,
  };
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

describe('shouldUseVolcOmniMultiReference', () => {
  it('routes classic volcengine protocol to omni for Seedance 2.x models with references', () => {
    assert.equal(
      videoClient.shouldUseVolcOmniMultiReference('volcengine', 'doubao-seedance-2.5-260628', [
        'https://cdn/scene.jpg',
        'https://cdn/role.jpg',
      ]),
      true
    );
    assert.equal(
      videoClient.shouldUseVolcOmniMultiReference('volcengine', 'jimeng-video-seedance-2.0', [
        'https://cdn/scene.jpg',
      ]),
      true
    );
  });

  it('keeps classic first/last-frame path when no references are given', () => {
    assert.equal(
      videoClient.shouldUseVolcOmniMultiReference('volcengine', 'doubao-seedance-2.5-260628', []),
      false
    );
    assert.equal(
      videoClient.shouldUseVolcOmniMultiReference('volcengine', 'doubao-seedance-2.5-260628', null),
      false
    );
  });

  it('does not reroute non Seedance 2.x models (classic duration/role behavior preserved)', () => {
    assert.equal(
      videoClient.shouldUseVolcOmniMultiReference('volcengine', 'doubao-seedance-1-5-pro', [
        'https://cdn/scene.jpg',
      ]),
      false
    );
    assert.equal(
      videoClient.shouldUseVolcOmniMultiReference('volcengine', 'doubao-seedance-1-0-pro', [
        'https://cdn/scene.jpg',
      ]),
      false
    );
  });

  it('does not reroute other protocols', () => {
    assert.equal(
      videoClient.shouldUseVolcOmniMultiReference('sora', 'doubao-seedance-2.5-260628', [
        'https://cdn/scene.jpg',
      ]),
      false
    );
    assert.equal(
      videoClient.shouldUseVolcOmniMultiReference('kling_omni', 'kling-video-o1', [
        'https://cdn/scene.jpg',
      ]),
      false
    );
  });
});

describe('isSeedance2FamilyModel', () => {
  it('recognizes 2.5 / 2.0 official and gateway alias names', () => {
    assert.equal(videoClient.isSeedance2FamilyModel('Doubao-Seedance-2.5 260628'), true);
    assert.equal(videoClient.isSeedance2FamilyModel('doubao-seedance-2-0-250528'), true);
    assert.equal(videoClient.isSeedance2FamilyModel('jimeng-video-seedance-2.0'), true);
    assert.equal(videoClient.isSeedance2FamilyModel('mingiz-sd2'), true);
  });

  it('rejects 1.x models', () => {
    assert.equal(videoClient.isSeedance2FamilyModel('doubao-seedance-1-5-pro'), false);
    assert.equal(videoClient.isSeedance2FamilyModel('seedance-lite-t2v'), false);
  });
});

describe('callVideoApi classic volcengine protocol with Seedance 2.x references', () => {
  beforeEach(() => {
    aiConfigService.listConfigs = () => [makeVolcengineConfig()];
  });

  afterEach(() => {
    aiConfigService.listConfigs = originalListConfigs;
    global.fetch = originalFetch;
  });

  it('sends reference_image content parts instead of dropping them (issue #49)', async () => {
    let calledUrl = '';
    let calledBody = null;
    global.fetch = async (url, options) => {
      calledUrl = String(url);
      calledBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'task-1', status: 'processing' }),
      };
    };

    const result = await videoClient.callVideoApi(null, noopLog, {
      prompt: '分镜描述',
      model: 'doubao-seedance-2.5-260628',
      provider: 'volcengine',
      duration: 5,
      aspect_ratio: '16:9',
      reference_urls: ['https://cdn/scene.jpg', 'https://cdn/role.jpg'],
      video_gen_id: 1,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.task_id, 'task-1');
    assert.match(calledUrl, /\/contents\/generations\/tasks$/);
    const imageParts = calledBody.content.filter((p) => p.type === 'image_url');
    assert.equal(imageParts.length, 2);
    assert.deepEqual(
      imageParts.map((p) => p.role),
      ['reference_image', 'reference_image']
    );
    assert.deepEqual(
      imageParts.map((p) => p.image_url.url),
      ['https://cdn/scene.jpg', 'https://cdn/role.jpg']
    );
    assert.equal(calledBody.task_type, 'i2v');
    assert.equal(calledBody.model, 'doubao-seedance-2.5-260628');
  });
});
