// 浏览器插件上传接口的凭证签发与校验
// 方案：HMAC-SHA256(secret, `storyboard_id=<id>&ts=<ts>&nonce=<nonce>`) + 时间戳时效 + nonce 防重放
const crypto = require('crypto');

const usedNonces = new Map(); // nonce -> 过期毫秒时间戳（保留至凭证本身失效后 1 分钟）

const DEFAULT_TTL_SECONDS = 3600;

/** 密钥：优先环境变量 LMD_EXTENSION_UPLOAD_SECRET，其次 config.extension.upload_secret */
function resolveSecret(cfg) {
  const fromEnv = process.env.LMD_EXTENSION_UPLOAD_SECRET;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const fromCfg = cfg?.extension?.upload_secret;
  return fromCfg && String(fromCfg).trim() ? String(fromCfg).trim() : '';
}

/** 时间戳有效窗口（秒） */
function resolveTtlSeconds(cfg) {
  const n = Number(cfg?.extension?.upload_ttl_seconds);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTL_SECONDS;
}

/** 待签名原文：字段顺序固定，避免签名/校验不一致 */
function buildCanonical({ storyboardId, ts, nonce }) {
  return `storyboard_id=${storyboardId}&ts=${ts}&nonce=${nonce}`;
}

function hmacHex(secret, text) {
  return crypto.createHmac('sha256', secret).update(text, 'utf8').digest('hex');
}

function pruneNonces(nowMs) {
  if (usedNonces.size < 1000) return;
  for (const [key, expiresAt] of usedNonces) {
    if (expiresAt <= nowMs) usedNonces.delete(key);
  }
}

/** 签发上传凭证：{ ok, ts, nonce, sign, expires_in } */
function issueCredential(cfg, storyboardId, nowMs = Date.now()) {
  const secret = resolveSecret(cfg);
  if (!secret) return { ok: false, reason: '未配置 extension.upload_secret' };
  const sid = Number(storyboardId);
  if (!Number.isFinite(sid) || sid <= 0) return { ok: false, reason: 'storyboard_id 非法' };
  const ts = Math.floor(nowMs / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const sign = hmacHex(secret, buildCanonical({ storyboardId: sid, ts, nonce }));
  return { ok: true, ts, nonce, sign, expires_in: resolveTtlSeconds(cfg) };
}

/** 校验上传凭证：{ ok } 或 { ok:false, reason } */
function verifyCredential(cfg, { storyboardId, ts, nonce, sign }, nowMs = Date.now()) {
  const secret = resolveSecret(cfg);
  if (!secret) return { ok: false, reason: '未配置 extension.upload_secret' };
  const sid = Number(storyboardId);
  if (!Number.isFinite(sid) || sid <= 0) return { ok: false, reason: '缺失或非法 storyboard_id' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return { ok: false, reason: '缺失或非法 ts' };
  const nonceKey = nonce != null ? String(nonce).trim() : '';
  if (!nonceKey) return { ok: false, reason: '缺失 nonce' };
  const signKey = sign != null ? String(sign).trim().toLowerCase() : '';
  if (!signKey) return { ok: false, reason: '缺失 sign' };

  const nowSec = Math.floor(nowMs / 1000);
  const ttl = resolveTtlSeconds(cfg);
  if (Math.abs(nowSec - tsNum) > ttl) return { ok: false, reason: '签名已过期' };

  const cached = usedNonces.get(nonceKey);
  if (cached && cached > nowMs) return { ok: false, reason: 'nonce 已被使用' };

  const expect = hmacHex(secret, buildCanonical({ storyboardId: sid, ts: tsNum, nonce: nonceKey }));
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(signKey, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: '签名不匹配' };
  }

  // 校验通过后登记 nonce，保留至该凭证失效（ts + ttl）后 1 分钟，保证有效窗口内无法重放
  usedNonces.set(nonceKey, (tsNum + ttl) * 1000 + 60 * 1000);
  pruneNonces(nowMs);
  return { ok: true };
}

module.exports = { issueCredential, verifyCredential, buildCanonical, resolveTtlSeconds };
