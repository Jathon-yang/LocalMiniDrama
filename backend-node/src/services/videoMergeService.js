const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

/** storyboards.local_path 是「主图/视频」混用字段，按扩展名判断是否为图片 */
function isImagePath(filePath) {
  return IMAGE_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  return {
    id: r.id,
    episode_id: r.episode_id,
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const mergeOptionsJson = (() => {
    const o = req.merge_options;
    if (o && typeof o === 'object') return JSON.stringify(o);
    return '{}';
  })();
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    Number(req.episode_id) || 0,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** 将 video_url 解析为本地文件路径，或下载到 temp 返回路径 */
async function resolveVideoToLocalPath(videoUrl, baseUrl, storageRoot, tempDir, index, log) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const u = videoUrl.trim();
  // 1) URL 以 baseUrl 开头（如 http://localhost:5679/static）-> 对应 storageRoot 下相对路径
  if (baseUrl && (u.startsWith(baseUrl) || u.startsWith(baseUrl.replace(/\/$/, '')))) {
    const base = baseUrl.replace(/\/$/, '');
    const rel = u.startsWith(base + '/') ? u.slice(base.length + 1) : u.slice(base.length).replace(/^\//, '');
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath)) {
        log.info('Video merge: using local static file', { index, path: localPath });
        return localPath;
      }
    }
  }
  // 1.5) 任意 host 的 /static/xxx URL（base_url 改过内网 IP 的历史数据也能定位到本地文件）
  const staticIdx = u.indexOf('/static/');
  if (staticIdx >= 0) {
    const rel = u.slice(staticIdx + '/static/'.length);
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath)) {
        log.info('Video merge: using local static file (by /static/)', { index, path: localPath });
        return localPath;
      }
    }
  }
  // 2) 已是本地绝对路径且存在
  if (path.isAbsolute(u) && fs.existsSync(u)) {
    log.info('Video merge: using absolute path', { index, path: u });
    return u;
  }
  // 3) 相对路径（相对 storageRoot）
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    const localPath = path.join(storageRoot, u.replace(/^\//, '').replace(/\//g, path.sep));
    if (fs.existsSync(localPath)) {
      log.info('Video merge: using relative path', { index, path: localPath });
      return localPath;
    }
  }
  // 4) 远程 URL：下载到 temp
  const ext = u.includes('.mp4') ? '.mp4' : u.includes('.webm') ? '.webm' : '.mp4';
  const destPath = path.join(tempDir, `dl_${Date.now()}_${index}${ext}`);
  try {
    const res = await fetch(u, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    log.info('Video merge: downloaded to temp', { index, dest: destPath });
    return destPath;
  } catch (e) {
    log.warn('Video merge: download failed', { index, url: u, error: e.message });
    return null;
  }
}

/**
 * ffmpeg concat 参数构造：
 * - 默认 `-c copy` 流拷贝：快且无损，但要求各片段编码参数一致；
 * - transcode：重编码兜底。AI 分镜片段常出现编码/分辨率/采样率不一致，
 *   流拷贝 concat 会直接失败，整集退化成只有首段（issue #21 / #14）。
 */
function buildConcatArgs(listFile, outputPath, transcode = false) {
  if (!transcode) {
    return ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outputPath];
  }
  return [
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];
}

function runFfmpegConcatOnce(listFile, outputPath, transcode, log) {
  const ffmpegBin = getFfmpegPath();
  const { spawnSync } = require('child_process');
  const result = spawnSync(ffmpegBin, buildConcatArgs(listFile, outputPath, transcode), {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    log.warn('Video merge: ffmpeg spawn error', { error: result.error.message, transcode: !!transcode });
    return false;
  }
  if (result.status !== 0) {
    log.warn('Video merge: ffmpeg failed', {
      transcode: !!transcode,
      stderr: result.stderr?.slice(-500),
    });
    return false;
  }
  return true;
}

/** 读取视频文件真实时长（秒），失败返回 null */
function probeDuration(filePath) {
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync(getFfprobePath(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath,
    ], { encoding: 'utf8' });
    if (res.status !== 0) return null;
    const d = parseFloat(String(res.stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch (_) {
    return null;
  }
}

/**
 * 校验合并结果时长是否接近各输入片段时长之和。
 * 流拷贝 concat 在编码参数不一致时可能「成功退出」但只保留首段，需要识别出来。
 */
function isConcatResultComplete(localPaths, outputPath, log) {
  const expected = localPaths.reduce((sum, p) => sum + (probeDuration(p) || 0), 0);
  const actual = probeDuration(outputPath);
  if (!expected || !actual) return true; // 无法探测时不阻塞合并
  const complete = actual >= expected * 0.9;
  if (!complete) {
    log.warn('Video merge: concat result shorter than expected', {
      expected: Math.round(expected * 100) / 100,
      actual: Math.round(actual * 100) / 100,
      clip_count: localPaths.length,
    });
  }
  return complete;
}

/** 探测视频流参数，失败返回 null */
function probeVideoInfo(filePath) {
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync(getFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
      '-of', 'json', filePath,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (res.status !== 0) return null;
    const streams = JSON.parse(String(res.stdout || '{}')).streams || [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    if (!v || !v.width || !v.height) return null;
    const [num, den] = String(v.r_frame_rate || '0/1').split('/').map(Number);
    const fps = den ? num / den : 0;
    return {
      width: Number(v.width),
      height: Number(v.height),
      vcodec: v.codec_name || '',
      fps: fps ? Math.round(fps * 100) / 100 : 0,
      hasAudio: !!a,
      acodec: a ? a.codec_name : null,
      sampleRate: a ? Number(a.sample_rate) || 44100 : null,
      channels: a ? Number(a.channels) || 2 : null,
    };
  } catch (_) {
    return null;
  }
}

/** 所有片段编码参数完全一致时才可直接流拷贝，否则拼接处会时间戳错乱导致播放卡在第一段 */
function canStreamCopy(infos) {
  const first = infos[0];
  if (!first) return false;
  return infos.every((i) => i
    && i.width === first.width
    && i.height === first.height
    && i.vcodec === first.vcodec
    && i.fps === first.fps
    && i.hasAudio === first.hasAudio
    && (!first.hasAudio || (
      i.acodec === first.acodec
      && i.sampleRate === first.sampleRate
      && i.channels === first.channels
    )));
}

/** 把单个片段重编码到统一的分辨率/帧率/音频参数 */
function normalizeClip(input, output, target, info, log) {
  const { spawnSync } = require('child_process');
  const vf = [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${target.fps}`,
  ].join(',');
  const args = ['-y', '-i', input];
  // 片段缺音轨时补静音，保证各片段音视频流结构一致
  if (target.hasAudio && !info.hasAudio) {
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${target.sampleRate}`);
  }
  args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  if (target.hasAudio) {
    args.push('-c:a', 'aac', '-ar', String(target.sampleRate), '-ac', '2');
    if (!info.hasAudio) args.push('-shortest');
  } else {
    args.push('-an');
  }
  args.push(output);
  const res = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    log.warn('Video merge: normalize clip failed', {
      input,
      error: res.error?.message,
      stderr: res.stderr?.slice(-500),
    });
    return false;
  }
  return true;
}

/** 把所有片段统一参数后输出到临时目录，返回 { dir, paths }，失败返回 null */
function normalizeClips(localPaths, infos, log) {
  const first = infos[0];
  const withAudio = infos.find((i) => i && i.hasAudio);
  const target = {
    width: first.width % 2 === 0 ? first.width : first.width + 1,
    height: first.height % 2 === 0 ? first.height : first.height + 1,
    fps: first.fps || 30,
    hasAudio: infos.some((i) => i && i.hasAudio),
    sampleRate: (withAudio && withAudio.sampleRate) || 44100,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drama-clip-norm-'));
  const paths = [];
  for (let i = 0; i < localPaths.length; i++) {
    const out = path.join(dir, `norm_${i}.mp4`);
    if (!normalizeClip(localPaths[i], out, target, infos[i], log)) {
      for (const p of paths) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }
      try { fs.rmdirSync(dir); } catch (_) {}
      return null;
    }
    paths.push(out);
  }
  log.info('Video merge: clips normalized', {
    clip_count: paths.length, width: target.width, height: target.height, fps: target.fps, audio: target.hasAudio,
  });
  return { dir, paths };
}

/**
 * 把一张图片渲染成按分镜时长展示的静帧视频片段。
 * 图片分镜没有视频流，直接参与 concat 只会得到 0.04 秒的瞬间，表现为成片里大量片段不足 1 秒。
 */
function buildStillClip(imagePath, outputPath, target, log) {
  const { spawnSync } = require('child_process');
  const duration = Math.max(0.2, Number(target.duration) || 5);
  const width = target.width % 2 === 0 ? target.width : target.width + 1;
  const height = target.height % 2 === 0 ? target.height : target.height + 1;
  const fps = target.fps || 30;
  const sampleRate = target.sampleRate || 44100;
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
  ].join(',');
  const args = ['-y', '-loop', '1', '-framerate', String(fps), '-t', String(duration), '-i', imagePath];
  if (target.hasAudio) {
    args.push('-f', 'lavfi', '-t', String(duration), '-i', `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`);
  }
  args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-t', String(duration));
  if (target.hasAudio) {
    args.push('-c:a', 'aac', '-ar', String(sampleRate), '-ac', '2', '-shortest');
  } else {
    args.push('-an');
  }
  args.push(outputPath);
  const res = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    log.warn('Video merge: build still clip failed', {
      input: imagePath,
      error: res.error?.message,
      stderr: res.stderr?.slice(-500),
    });
    return false;
  }
  return true;
}

/**
 * 把图片分镜按计划时长渲染成静帧片段，输出参数尽量与视频片段对齐，便于后续直接流拷贝拼接。
 * @returns {{ dir: string, paths: string[] } | null}
 */
function renderStillClips(localPaths, durations, log) {
  const videoInfos = localPaths.map((p) => (isImagePath(p) ? null : probeVideoInfo(p)));
  const firstVideo = videoInfos.find(Boolean) || null;
  const withAudio = videoInfos.find((i) => i && i.hasAudio) || null;
  const target = {
    width: firstVideo ? firstVideo.width : 1280,
    height: firstVideo ? firstVideo.height : 720,
    fps: (firstVideo && firstVideo.fps) || 30,
    hasAudio: videoInfos.some((i) => i && i.hasAudio),
    sampleRate: (withAudio && withAudio.sampleRate) || 44100,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drama-still-clip-'));
  const paths = [];
  for (let i = 0; i < localPaths.length; i++) {
    if (!isImagePath(localPaths[i])) {
      paths.push(localPaths[i]);
      continue;
    }
    const out = path.join(dir, `still_${i}.mp4`);
    if (!buildStillClip(localPaths[i], out, { ...target, duration: durations[i] }, log)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      return null;
    }
    paths.push(out);
  }
  log.info('Video merge: still images rendered as clips', {
    image_count: localPaths.filter((p) => isImagePath(p)).length,
    width: target.width,
    height: target.height,
    fps: target.fps,
    audio: target.hasAudio,
  });
  return { dir, paths };
}

/** 使用 ffmpeg concat 合并多个视频文件：参数一致时流拷贝，不一致时先归一化再合并 */
function runFfmpegConcat(localPaths, outputPath, log) {
  const listFile = path.join(path.dirname(outputPath), `concat_list_${Date.now()}.txt`);
  let norm = null;
  try {
    const writeList = (files) => {
      const lines = files.map((p) => {
        const normalized = p.replace(/\\/g, '/');
        return `file '${normalized.replace(/'/g, "'\\''")}'`;
      });
      fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    };
    writeList(localPaths);

    const infos = localPaths.map(probeVideoInfo);
    const allKnown = infos.every(Boolean);

    // 片段参数不一致：先归一化再拼接，避免直接流拷贝后播放器卡在第一段
    if (allKnown && !canStreamCopy(infos)) {
      log.warn('Video merge: clip parameters differ, normalizing before concat', {
        clip_count: localPaths.length,
        width: infos[0].width,
        height: infos[0].height,
        fps: infos[0].fps,
      });
      norm = normalizeClips(localPaths, infos, log);
      if (norm) {
        writeList(norm.paths);
        if (
          runFfmpegConcatOnce(listFile, outputPath, false, log)
          && isConcatResultComplete(norm.paths, outputPath, log)
        ) {
          return true;
        }
      }
      writeList(localPaths);
      return runFfmpegConcatOnce(listFile, outputPath, true, log);
    }

    if (
      runFfmpegConcatOnce(listFile, outputPath, false, log)
      && isConcatResultComplete(localPaths, outputPath, log)
    ) {
      return true;
    }
    log.warn('Video merge: stream copy concat failed or incomplete, retrying with re-encode', {
      clip_count: localPaths.length,
    });
    return runFfmpegConcatOnce(listFile, outputPath, true, log);
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
    if (norm) {
      for (const p of norm.paths) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }
      try { fs.rmdirSync(norm.dir); } catch (_) {}
    }
  }
}

/**
 * 异步处理视频合成：使用 ffmpeg 合并多段视频；单片段直接使用原视频；
 * 多片段合并失败时标记任务失败（不再退化成首段）。
 */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r) return;
  const taskId = r.task_id;
  const episodeId = r.episode_id;
  let scenes = [];
  try {
    scenes = JSON.parse(r.scenes || '[]');
  } catch (_) {
    log.warn('video merge parse scenes failed', { merge_id: mergeId });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE video_merges SET status = ? WHERE id = ?').run('processing', mergeId);
  const taskService = require('./taskService');
  if (scenes.length === 0) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '无有效视频片段', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '无有效视频片段');
    return;
  }
  const first = scenes[0];
  const mergedUrlFallback = first && first.video_url ? first.video_url : null;
  if (!mergedUrlFallback) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '首段无视频地址', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '首段无视频地址');
    return;
  }

  const totalDuration = scenes.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const storageRoot = getStorageRoot();
  const tempDir = path.join(require('os').tmpdir(), 'drama-video-merge');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const localPaths = [];
  const clipDurations = [];
  const toCleanup = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = await resolveVideoToLocalPath(
      scenes[i].video_url,
      baseUrl,
      storageRoot,
      tempDir,
      i,
      log
    );
    if (p) {
      localPaths.push(p);
      clipDurations.push(Number(scenes[i].duration) || 5);
      if (p.startsWith(tempDir)) toCleanup.push(p);
    }
  }

  const ffmpegAvailable = hasLocalFfmpeg();
  log.info('Video merge: ffmpeg check', {
    merge_id: mergeId,
    has_ffmpeg: ffmpegAvailable,
    ffmpeg_path: getFfmpegPath(),
    local_video_count: localPaths.length,
    cwd: process.cwd(),
  });

  // 图片分镜（只有主图、还没生成视频）直接 concat 只会得到 0.04 秒的瞬间，
  // 表现为成片里大量片段不足 1 秒；这里按分镜计划时长把图片渲染成静帧片段。
  let stillDir = null;
  if (ffmpegAvailable && localPaths.some((p) => isImagePath(p))) {
    stillDir = renderStillClips(localPaths, clipDurations, log);
    if (stillDir) {
      localPaths.splice(0, localPaths.length, ...stillDir.paths);
    } else {
      log.warn('Video merge: falling back to raw image clips (still render failed)', { merge_id: mergeId });
    }
  }

  let mergedRelativePath = null;
  if (localPaths.length > 0 && ffmpegAvailable && localPaths.length <= 100) {
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, r.drama_id);
    const sub = projectSubdir && String(projectSubdir).trim();
    const mergedDir = sub
      ? path.join(storageRoot, sub, 'videos', 'merged')
      : path.join(storageRoot, 'videos', 'merged');
    if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
    const outputFileName = `merged_${Date.now()}.mp4`;
    const outputPath = path.join(mergedDir, outputFileName);
    const ok = runFfmpegConcat(localPaths, outputPath, log);
    if (ok && fs.existsSync(outputPath)) {
      mergedRelativePath = sub
        ? path.join(sub, 'videos', 'merged', outputFileName).replace(/\\/g, '/')
        : path.join('videos', 'merged', outputFileName).replace(/\\/g, '/');
      log.info('Video merge completed (ffmpeg)', { merge_id: mergeId, episode_id: episodeId, output: mergedRelativePath });
    }
  }

  let mergeOpts = {};
  try {
    mergeOpts = JSON.parse(r.merge_options || '{}');
  } catch (_) {
    mergeOpts = {};
  }
  const postNeed =
    !!mergeOpts.burn_narration_subtitles
    || !!mergeOpts.burn_dialogue_audio
    || !!(mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim());
  if (mergedRelativePath && ffmpegAvailable && postNeed) {
    const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    if (fs.existsSync(mergedAbsPath)) {
      const mergedPP = require('./mergedEpisodePostProcess');
      const post = await mergedPP.runMergedEpisodePostProcess(db, log, {
        mergedAbsPath,
        storageRoot,
        scenes,
        episodeId,
        mergeOpts,
      });
      if (post.ok && post.relativePath) {
        mergedRelativePath = post.relativePath;
        log.info('Video merge: merged episode post-process', { merge_id: mergeId, out: mergedRelativePath });
      } else if (post.error && post.error !== 'NO_POST_OPTS') {
        log.warn('Video merge: post-process skipped', { merge_id: mergeId, err: post.error });
      }
    }
  }

  for (const p of toCleanup) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
  if (stillDir) {
    try { fs.rmSync(stillDir.dir, { recursive: true, force: true }); } catch (_) {}
  }

  if (!mergedRelativePath) {
    // 只有一段视频时无需合并，直接使用原视频
    if (scenes.length === 1 && mergedUrlFallback) {
      db.prepare(
        'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
      ).run('completed', mergedUrlFallback, Math.round(totalDuration) || null, now, null, mergeId);
      db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(mergedUrlFallback, 'completed', now, episodeId);
      if (taskId) {
        taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: mergedUrlFallback, duration: Math.round(totalDuration) });
      }
      log.info('Video merge: single clip, no concat needed', { merge_id: mergeId, episode_id: episodeId });
      return;
    }
    // 多片段合并失败：明确报错，避免把首段当作合成结果（用户看到的就是「只包含第一个视频」）
    const reason = !ffmpegAvailable
      ? '未检测到 ffmpeg，无法合成视频。请安装 ffmpeg 或将其放入 backend-node/tools/ffmpeg/ 目录'
      : localPaths.length < scenes.length
        ? `视频合成失败：仅成功读取 ${localPaths.length}/${scenes.length} 个视频片段`
        : '视频合成失败：ffmpeg 合并出错，请查看后端日志';
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', reason, mergeId);
    db.prepare('UPDATE episodes SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, episodeId);
    if (taskId) taskService.updateTaskError(db, taskId, reason);
    log.warn('Video merge failed', { merge_id: mergeId, episode_id: episodeId, reason });
    return;
  }

  const finalMergedUrl = mergedRelativePath;
  db.prepare(
    'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
  ).run('completed', finalMergedUrl, Math.round(totalDuration) || null, now, null, mergeId);
  db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', now, episodeId);
  if (taskId) {
    taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalMergedUrl, duration: Math.round(totalDuration) });
  }
}

module.exports = {
  list,
  getById,
  create,
  deleteById,
  processVideoMerge,
  buildConcatArgs,
  runFfmpegConcat,
};
