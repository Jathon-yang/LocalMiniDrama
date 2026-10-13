const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const aiClient = require('../src/services/aiClient');
const aiConfigService = require('../src/services/aiConfigService');

const originalListConfigs = aiConfigService.listConfigs;

const VOLC_MAX_TOKENS_ERROR = JSON.stringify({
  error: {
    message:
      'The parameter `max_completion_tokens` specified in the request are not valid: integer above maximum value, expected a value <= 12288, but got 16384 instead. Request id: 021787281042180b566464da517b102b4cb09cdfd60e7ee3d23dd',
    code: 'invalid_parameter',
  },
});

function makeConfig(baseUrl) {
  return {
    id: 1,
    service_type: 'text',
    is_active: true,
    is_default: true,
    provider: 'volcengine',
    base_url: baseUrl,
    api_key: 'test-key',
    model: ['doubao-seedance-1-6-pro'],
    default_model: 'doubao-seedance-1-6-pro',
  };
}

/** 按脚本逐次响应的本地 HTTP 服务器：[{ status, body } | { sse: [chunks] }] */
function startScriptedServer(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch (_) {}
      requests.push(body);
      const step = script[Math.min(requests.length - 1, script.length - 1)];
      if (step.sse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of step.sse) res.write(chunk);
        res.end();
        return;
      }
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      res.end(step.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

describe('isMaxTokensParamError', () => {
  it('detects the volcengine max_completion_tokens error from issue #39', () => {
    assert.equal(aiClient.isMaxTokensParamError(`HTTP 400: ${VOLC_MAX_TOKENS_ERROR}`), true);
  });

  it('detects other token-limit phrasings', () => {
    assert.equal(aiClient.isMaxTokensParamError('400: max_tokens is too large'), true);
    assert.equal(aiClient.isMaxTokensParamError('HTTP 400: token limit exceeded'), true);
    assert.equal(aiClient.isMaxTokensParamError('HTTP 400: invalid parameter max_tokens'), true);
  });

  it('ignores unrelated errors', () => {
    assert.equal(aiClient.isMaxTokensParamError('AI 返回内容为空'), false);
    assert.equal(aiClient.isMaxTokensParamError('HTTP 500: internal error'), false);
    assert.equal(aiClient.isMaxTokensParamError(''), false);
  });
});

describe('parseMaxTokensLimitFromError', () => {
  it('reads the vendor cap from "expected a value <= N"', () => {
    assert.equal(aiClient.parseMaxTokensLimitFromError(VOLC_MAX_TOKENS_ERROR), 12288);
    assert.equal(aiClient.parseMaxTokensLimitFromError('max_tokens must be less than or equal to 4096'), 4096);
  });

  it('reads "maximum (of) N" phrasings', () => {
    assert.equal(aiClient.parseMaxTokensLimitFromError('max_tokens above maximum of 8192'), 8192);
    assert.equal(aiClient.parseMaxTokensLimitFromError('max_tokens: maximum is 2048'), 2048);
  });

  it('returns null when no cap is stated', () => {
    assert.equal(aiClient.parseMaxTokensLimitFromError('invalid parameter max_tokens'), null);
    assert.equal(aiClient.parseMaxTokensLimitFromError(undefined), null);
  });
});

describe('clampMaxTokensInBody / stripMaxTokensFromBody', () => {
  it('clamps max_tokens and max_completion_tokens to the cap', () => {
    assert.deepEqual(aiClient.clampMaxTokensInBody({ model: 'm', max_tokens: 16384 }, 12288), {
      model: 'm',
      max_tokens: 12288,
    });
    assert.deepEqual(aiClient.clampMaxTokensInBody({ max_completion_tokens: 16384 }, 12288), {
      max_completion_tokens: 12288,
    });
  });

  it('returns null when nothing exceeds the cap', () => {
    assert.equal(aiClient.clampMaxTokensInBody({ max_tokens: 4000 }, 12288), null);
    assert.equal(aiClient.clampMaxTokensInBody({ model: 'm' }, 12288), null);
    assert.equal(aiClient.clampMaxTokensInBody({ max_tokens: 4000 }, null), null);
  });

  it('strips both token fields', () => {
    assert.deepEqual(aiClient.stripMaxTokensFromBody({ model: 'm', max_tokens: 1, max_completion_tokens: 2 }), {
      model: 'm',
    });
  });
});

describe('generateText max_tokens vendor-limit retry', () => {
  let serverHandle = null;

  beforeEach(() => {
    aiConfigService.listConfigs = () => [];
  });

  afterEach(() => {
    aiConfigService.listConfigs = originalListConfigs;
    if (serverHandle) {
      serverHandle.server.close();
      serverHandle = null;
    }
  });

  it('retries with the vendor cap instead of failing (issue #39)', async () => {
    serverHandle = await startScriptedServer([
      { status: 400, body: VOLC_MAX_TOKENS_ERROR },
      { sse: ['data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n', 'data: [DONE]\n\n'] },
    ]);
    aiConfigService.listConfigs = () => [makeConfig(`http://127.0.0.1:${serverHandle.port}`)];

    const text = await aiClient.generateText(null, { info() {}, warn() {}, error() {} }, 'text', '生成分镜', 'system', {
      model: 'doubao-seedance-1-6-pro',
      max_tokens: 16384,
    });

    assert.equal(text, '第一段');
    assert.equal(serverHandle.requests.length, 2);
    assert.equal(serverHandle.requests[0].max_tokens, 16384);
    assert.equal(serverHandle.requests[1].max_tokens, 12288);
  });

  it('retries without max_tokens when the error states no cap', async () => {
    serverHandle = await startScriptedServer([
      { status: 400, body: JSON.stringify({ error: { message: 'invalid parameter: max_tokens' } }) },
      { sse: ['data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n', 'data: [DONE]\n\n'] },
    ]);
    aiConfigService.listConfigs = () => [makeConfig(`http://127.0.0.1:${serverHandle.port}`)];

    const text = await aiClient.generateText(null, { info() {}, warn() {}, error() {} }, 'text', '生成分镜', 'system', {
      model: 'doubao-seedance-1-6-pro',
      max_tokens: 16384,
    });

    assert.equal(text, '第二段');
    assert.equal(serverHandle.requests.length, 2);
    assert.equal('max_tokens' in serverHandle.requests[1], false);
    assert.equal('max_completion_tokens' in serverHandle.requests[1], false);
  });

  it('does not retry unrelated errors', async () => {
    serverHandle = await startScriptedServer([
      { status: 500, body: JSON.stringify({ error: { message: 'internal error' } }) },
      { sse: ['data: {"choices":[{"delta":{"content":"不该走到这"}}]}\n\n', 'data: [DONE]\n\n'] },
    ]);
    aiConfigService.listConfigs = () => [makeConfig(`http://127.0.0.1:${serverHandle.port}`)];

    await assert.rejects(
      aiClient.generateText(null, { info() {}, warn() {}, error() {} }, 'text', 'p', 's', { max_tokens: 16384 })
    );
    assert.equal(serverHandle.requests.length, 1);
  });
});
