/**
 * 全能模式 universal_segment_text 统一格式：多子分镜段落（与 generate/polish 接口一致）
 */

// 第3行固定句式：按本镜是否存在「尾帧衔接首帧」二选一（首帧置顶时会占用 @图片1，场景顺延）
const DEFAULT_LINE3 =
  '环境、光影与陈设定性参考 @图片1。若 @图片1 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的室内空间与光线语义；须单镜头完整连续画面。';

const DEFAULT_LINE3_WITH_FIRST_FRAME =
  '环境、光影与陈设定性参考 @图片2（@图片1 为尾帧衔接首帧，第1个子分镜须从 @图片1 起始，禁止跳切）。若 @图片2 为宫格或多画面拼图，禁止成片复刻其分格或并列布局，仅提取统一的室内空间与光线语义；须单镜头完整连续画面。';

/** 按是否存在衔接首帧选择第3行 */
function buildDefaultLine3(hasContiguityFirstFrame) {
  return hasContiguityFirstFrame ? DEFAULT_LINE3_WITH_FIRST_FRAME : DEFAULT_LINE3;
}

function trim(s) {
  return s != null && String(s).trim() ? String(s).trim() : '';
}

/** 保留多行，仅规范换行 */
function normalizeUniversalSegmentTextNewlines(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/** 根据总秒数决定子分镜数 M（约每 5 秒一拍，1–8） */
function chooseBeatCount(durationSec) {
  const dur = Math.max(1, Math.min(120, Math.round(Number(durationSec) || 5)));
  return Math.min(8, Math.max(1, Math.round(dur / 5)));
}

/** 将总秒数拆成 M 个正整数且和为 dur */
function splitDurationSeconds(dur, m) {
  const base = Math.floor(dur / m);
  const rem = dur - base * m;
  return Array.from({ length: m }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * 分镜批量生成时模型未返回 universal_segment_text 时的多行兜底
 */
function buildFallbackUniversalMultiBeatText(sb, d, styleHint, opts = {}) {
  const dur = Math.max(1, Number(d.durationSec) || 5);
  const M = chooseBeatCount(dur);
  const secs = splitDurationSeconds(dur, M);
  const loc = [sb?.location, sb?.time].filter(Boolean).join('，').trim() || '叙事空间';
  const act = trim(d.action) || '人物在场景内完成本镜戏核动作';
  const res = trim(d.result);
  const dia = trim(d.dialogue);
  const narr = trim(d.narration);
  const atm = trim(sb?.atmosphere);
  const styleTail = trim(styleHint) || '电影感叙事';
  const styleLine = `画面风格和类型: 真人写实, 电影风格, 高清画质, ${styleTail}`;
  // 参考图顺序与提交一致：衔接首帧（若有）占 @图片1，场景随后，角色再后
  const hasFirstFrame = !!opts.hasContiguityFirstFrame;
  const sceneTag = hasFirstFrame ? '@图片2' : '@图片1';
  const charTag = hasFirstFrame ? '@图片3' : '@图片2';

  const lines = [styleLine, `生成一个由以下${M}个分镜组成的视频。`, buildDefaultLine3(hasFirstFrame)];

  for (let k = 0; k < M; k++) {
    const tk = secs[k];
    const isFirst = k === 0;
    const isLast = k === M - 1;
    let body = '';
    if (isFirst) {
      const anchor = hasFirstFrame ? '第1个子分镜须从 @图片1（尾帧衔接首帧）起始，禁止跳切；' : '';
      body = `${anchor}镜头从 ${sceneTag} 的${loc}建立画面起，平稳缓推向戏眼；${charTag} 处于${act.slice(0, 80)}，${atm ? `${atm}，` : ''}光影随空间纵深拉开。`;
    } else if (isLast) {
      body = `镜头徐徐拉回或推近收束；${charTag} ${res || '完成本镜动作阶段'}，情绪落点明确。`;
    } else {
      body = `镜头继续推进，跟住 ${charTag} 的动作节奏，${act.slice(0, 100)}，运镜含定镜与缓推轨衔接。`;
    }
    if (dia && (isLast || (M <= 2 && k === M - 1))) {
      body += ` ${charTag} 说："${dia.replace(/"/g, '')}"`;
    } else if (!dia && k === M - 1) {
      body += ' 无对白。';
    } else if (!dia && k < M - 1) {
      body += ' 无对白。';
    }
    if (narr && isLast) {
      body += ` 旁白（画面无声）："${narr.replace(/"/g, '')}"`;
    }
    lines.push(`分镜${k + 1}： ${tk}秒: ${body}`);
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_LINE3,
  DEFAULT_LINE3_WITH_FIRST_FRAME,
  buildDefaultLine3,
  normalizeUniversalSegmentTextNewlines,
  chooseBeatCount,
  splitDurationSeconds,
  buildFallbackUniversalMultiBeatText,
};
