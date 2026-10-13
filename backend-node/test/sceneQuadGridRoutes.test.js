const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sceneRoutes = require('../src/routes/scenes');
const sceneService = require('../src/services/sceneService');

const originalSingle = sceneService.generateSceneSingleImage;
const originalSinglePrompt = sceneService.generateSceneSinglePromptOnly;
const originalFourView = sceneService.generateSceneFourViewImage;
const originalFourViewPrompt = sceneService.generateScenePromptOnly;

function makeRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function callRoute(method, reqBody, params = {}) {
  const routes = sceneRoutes({ prepare: () => ({ get: () => null }) }, noopLog, {});
  const handler = routes[method];
  const res = makeRes();
  handler({ params, body: reqBody }, res);
  return res;
}

describe('POST /scenes/generate-image honors use_quad_grid (issue #29)', () => {
  afterEach(() => {
    sceneService.generateSceneSingleImage = originalSingle;
    sceneService.generateSceneFourViewImage = originalFourView;
  });

  it('uses single-image generation when use_quad_grid is false (checkbox unchecked)', async () => {
    let called = null;
    sceneService.generateSceneSingleImage = async () => {
      called = 'single';
      return { ok: true, image_generation: { id: 7 } };
    };
    sceneService.generateSceneFourViewImage = async () => {
      called = 'four_view';
      return { ok: true, image_generation: { id: 8 } };
    };

    const res = await callRoute('generateImage', { scene_id: 3, use_quad_grid: false });
    assert.equal(called, 'single');
    assert.equal(res.payload.data.message, '场景单图生成任务已提交');
    assert.equal(res.payload.data.image_generation.id, 7);
  });

  it('uses four-view generation when use_quad_grid is true (checkbox checked)', async () => {
    let called = null;
    sceneService.generateSceneSingleImage = async () => {
      called = 'single';
      return { ok: true, image_generation: { id: 7 } };
    };
    sceneService.generateSceneFourViewImage = async () => {
      called = 'four_view';
      return { ok: true, image_generation: { id: 8 } };
    };

    const res = await callRoute('generateImage', { scene_id: 3, use_quad_grid: true });
    assert.equal(called, 'four_view');
    assert.equal(res.payload.data.message, '场景四视图生成任务已提交');
  });

  it('keeps legacy four-view behavior for callers that omit the flag', async () => {
    let called = null;
    sceneService.generateSceneSingleImage = async () => {
      called = 'single';
      return { ok: true, image_generation: { id: 7 } };
    };
    sceneService.generateSceneFourViewImage = async () => {
      called = 'four_view';
      return { ok: true, image_generation: { id: 8 } };
    };

    await callRoute('generateImage', { scene_id: 3 });
    assert.equal(called, 'four_view');
  });
});

describe('POST /scenes/:id/generate-prompt honors mode (issue #29)', () => {
  afterEach(() => {
    sceneService.generateSceneSinglePromptOnly = originalSinglePrompt;
    sceneService.generateScenePromptOnly = originalFourViewPrompt;
  });

  it('returns polished_prompt_single when mode is single', async () => {
    let called = null;
    sceneService.generateSceneSinglePromptOnly = async () => {
      called = 'single';
      return { ok: true, polished_prompt_single: '单图提示词' };
    };
    sceneService.generateScenePromptOnly = async () => {
      called = 'four_view';
      return { ok: true, polished_prompt: '四宫格提示词' };
    };

    const res = await callRoute('generatePrompt', { mode: 'single' }, { scene_id: '5' });
    assert.equal(called, 'single');
    assert.equal(res.payload.data.polished_prompt_single, '单图提示词');
    assert.equal(res.payload.data.polished_prompt, undefined);
    assert.equal(res.payload.data.message, '单图提示词已生成');
  });

  it('returns polished_prompt by default', async () => {
    let called = null;
    sceneService.generateSceneSinglePromptOnly = async () => {
      called = 'single';
      return { ok: true, polished_prompt_single: '单图提示词' };
    };
    sceneService.generateScenePromptOnly = async () => {
      called = 'four_view';
      return { ok: true, polished_prompt: '四宫格提示词' };
    };

    const res = await callRoute('generatePrompt', {}, { scene_id: '5' });
    assert.equal(called, 'four_view');
    assert.equal(res.payload.data.polished_prompt, '四宫格提示词');
  });
});
