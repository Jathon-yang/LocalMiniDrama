/**
 * 剪映（JianYing / CapCut）草稿导出服务。
 *
 * 将某一集的分镜视频按顺序铺到剪映时间线上，并可选地带上：
 * - 对白配音音轨（storyboards.audio_local_path）
 * - 解说旁白字幕轨（storyboards.narration）
 *
 * 输出一个 ZIP：解压到剪映草稿目录（如
 * `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`）后即可在剪映中打开。
 * 分镜视频与配音会一并打包进草稿的 materials/ 目录，草稿 JSON 引用该目录下的绝对路径。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { spawnSync } = require('child_process');
const { getFfprobePath } = require('../utils/ffmpegPath');
const { ffprobeDurationSec } = require('./mergedEpisodePostProcess');

const FPS = 30;
const US = 1000000; // 1 秒 = 1,000,000 微秒

const PLATFORM = {
  app_id: 3704,
  app_source: 'lv',
  app_version: '5.9.0',
  device_id: '',
  hard_disk_id: '',
  mac_address: '',
  os: process.platform === 'darwin' ? 'mac' : 'windows',
  os_version: '',
};

function getStoragePath(cfg) {
  const raw = cfg?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

/**
 * 解析剪映草稿根目录（用于生成素材绝对路径）。
 * 优先取配置 storage.jianying_draft_path，其次按平台默认目录，取不到则返回 null。
 */
function getJianyingDraftRoot(cfg) {
  const custom = cfg?.storage?.jianying_draft_path;
  if (custom && String(custom).trim()) {
    const p = String(custom).trim();
    return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Movies/JianyingPro/User Data/Projects/com.lveditor.draft');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || '';
    return base ? path.join(base, 'JianyingPro/User Data/Projects/com.lveditor.draft') : null;
  }
  return null;
}

function toAbsPath(storageRoot, relPath) {
  if (!relPath) return null;
  const s = String(relPath).trim();
  if (!s) return null;
  return path.isAbsolute(s) ? s : path.join(storageRoot, s.replace(/\//g, path.sep));
}

function fileExists(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/** 读取视频宽高，失败时返回 null */
function ffprobeVideoSize(filePath) {
  try {
    const probe = getFfprobePath();
    const r = spawnSync(
      probe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', filePath],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    );
    if (r.status !== 0) return null;
    const m = /^(\d+)x(\d+)/.exec(String(r.stdout || '').trim());
    if (!m) return null;
    const width = Number(m[1]);
    const height = Number(m[2]);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch (_) {
    return null;
  }
}

function parseRatio(raw) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:：xX/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(raw || ''));
  if (!m) return { w: 16, h: 9 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : { w: 16, h: 9 };
}

/** 依据画面比例与分辨率（480p/720p/1080p）推算画布宽高，短边取分辨率数值 */
function canvasSize(ratioRaw, resolution) {
  const { w, h } = parseRatio(ratioRaw);
  const shortSide = Number(String(resolution || '').replace(/[^\d]/g, '')) || 720;
  const longSide = Math.round((shortSide * Math.max(w, h)) / Math.min(w, h) / 2) * 2;
  return w >= h ? { width: longSide, height: shortSide } : { width: shortSide, height: longSide };
}

function clampText(s, max = 200) {
  const t = String(s == null ? '' : s).trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * 解析某分镜当前生效的本地视频路径：
 * 优先 storyboards.local_path（用户手动上传 / 最近生成回写），否则取最新完成的 video_generations。
 */
function resolveStoryboardVideoAbs(db, storageRoot, sb) {
  const sbAbs = toAbsPath(storageRoot, sb.local_path);
  if (fileExists(sbAbs)) return sbAbs;
  const vg = db.prepare(
    "SELECT local_path FROM video_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"
  ).get(sb.id);
  const vgAbs = toAbsPath(storageRoot, vg && vg.local_path);
  if (fileExists(vgAbs)) return vgAbs;
  return null;
}

function buildVideoMaterial({ id, filePath, name, width, height, durationUs }) {
  return {
    id,
    type: 'video',
    path: filePath,
    media_path: '',
    local_material_id: id,
    material_name: name,
    duration: durationUs,
    width,
    height,
    crop: {
      lower_left_x: 0,
      lower_left_y: 1,
      lower_right_x: 1,
      lower_right_y: 1,
      upper_left_x: 0,
      upper_left_y: 0,
      upper_right_x: 1,
      upper_right_y: 0,
    },
    crop_ratio: 'free',
    crop_scale: 1,
    has_audio: true,
    reverse_path: '',
    source_platform: 0,
    stable_volume: false,
    frame_rate: FPS,
    aigc_type: 'none',
    check_flag: 63487,
    has_sound_separated: false,
    sound_channel_mapping: 0,
    is_ai_generate_content: false,
    is_unified_beauty_mode: false,
    extra_type_option: 0,
    aigc_draft: '',
    object_edit: {
      aigc: { aigc_type: 'none', aigc_draft: '' },
      filter: { draft: '' },
      hsl: [],
      mask: null,
      smart_color_adjust: { enhance_type: 'default' },
    },
    video_algorithm: {
      algorithms: [],
      complement_frame_config: null,
      deflicker: null,
      gameplay_configs: [],
      motion_blur_config: null,
      noise_reduction: null,
      path: '',
      quality_enhance: null,
      smart_complement_frame: null,
      super_resolution: null,
      time_range: null,
    },
  };
}

function buildAudioMaterial({ id, filePath, name, durationUs }) {
  return {
    id,
    type: 'extract',
    path: filePath,
    media_path: '',
    local_material_id: id,
    name,
    music_id: '',
    duration: durationUs,
    source_platform: 0,
    aigc_type: 'none',
    check_flag: 1,
    sound_channel_mapping: 0,
    is_ai_generate_content: false,
    app_id: 0,
    category_id: '',
    category_name: 'local',
    wave_points: [],
    request_id: '',
    text_id: '',
    tone_category_id: '',
    tone_category_name: '',
    tone_effect_id: '',
    tone_effect_name: '',
    tone_platform: '',
    tone_second_category_id: '',
    tone_second_category_name: '',
    tone_speaker: '',
    tone_type: '',
  };
}

function buildTextMaterial({ id, text }) {
  return {
    id,
    type: 'subtitle',
    content: JSON.stringify({
      text,
      styles: [
        {
          fill: { content: { solid: { color: [1, 1, 1] } } },
          range: [0, text.length],
          size: 6,
          font: { id: '', path: '' },
          strokes: [{ content: { solid: { color: [0, 0, 0] } }, width: 0.06 }],
        },
      ],
    }),
    check_flag: 1,
  };
}

function baseClip() {
  return {
    alpha: 1,
    flip: { horizontal: false, vertical: false },
    rotation: 0,
    scale: { x: 1, y: 1 },
    transform: { x: 0, y: 0 },
  };
}

function buildVideoSegment({ id, materialId, startUs, durationUs }) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: startUs, duration: durationUs },
    source_timerange: { start: 0, duration: durationUs },
    speed: 1,
    volume: 1,
    visible: true,
    reverse: false,
    is_tone_modify: false,
    clip: baseClip(),
    uniform_scale: { on: true, value: 1 },
    render_index: 0,
    track_render_index: 0,
    extra_material_refs: [],
    hdr_settings: { intensity: 1, mode: 1, nits: 1000 },
    keyframe_refs: [],
  };
}

function buildAudioSegment({ id, materialId, startUs, durationUs }) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: startUs, duration: durationUs },
    source_timerange: { start: 0, duration: durationUs },
    speed: 1,
    volume: 1,
    visible: true,
    reverse: false,
    is_tone_modify: false,
    clip: baseClip(),
    uniform_scale: { on: true, value: 1 },
    render_index: 0,
    track_render_index: 0,
    extra_material_refs: [],
    hdr_settings: null,
    keyframe_refs: [],
  };
}

function buildTextSegment({ id, materialId, startUs, durationUs }) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: startUs, duration: durationUs },
    source_timerange: null,
    speed: 1,
    volume: 1,
    visible: true,
    clip: baseClip(),
    uniform_scale: { on: true, value: 1 },
    render_index: 1400,
    track_render_index: 0,
    extra_material_refs: [],
    keyframe_refs: [],
  };
}

function emptyMaterials() {
  return {
    audio_effects: [],
    audio_fades: [],
    audio_track_indexes: [],
    audios: [],
    beats: [],
    canvases: [],
    characters: [],
    color_curves: [],
    common_mask: [],
    digital_humans: [],
    drafts: [],
    effects: [],
    flowers: [],
    folders: [],
    green_screens: [],
    handwrites: [],
    hsl: [],
    images: [],
    log_color_wheels: [],
    loudnesses: [],
    manual_dehaze_effects: [],
    manual_dehaze_strengths: [],
    masks: [],
    material_animations: [],
    material_colors: [],
    multi_language_refs: [],
    placeholders: [],
    plugin_effects: [],
    primary_color_wheels: [],
    realtime_denoises: [],
    shapes: [],
    smart_crops: [],
    sound_channel_mappings: [],
    speeds: [],
    stickers: [],
    tail_leaders: [],
    text_templates: [],
    texts: [],
    time_marks: [],
    transitions: [],
    video_effects: [],
    video_trackings: [],
    videos: [],
    vocal_beautifys: [],
    vocal_separations: [],
  };
}

function buildDraftContent({ draftName, size, durationUs, videoItems, audioItems, textItems }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const materials = emptyMaterials();

  const videoSegments = [];
  for (const it of videoItems) {
    const materialId = uuidv4();
    materials.videos.push(
      buildVideoMaterial({
        id: materialId,
        filePath: it.filePath,
        name: it.name,
        width: it.width,
        height: it.height,
        durationUs: it.durationUs,
      })
    );
    videoSegments.push(
      buildVideoSegment({ id: uuidv4(), materialId, startUs: it.startUs, durationUs: it.durationUs })
    );
  }

  const audioSegments = [];
  for (const it of audioItems) {
    const materialId = uuidv4();
    materials.audios.push(
      buildAudioMaterial({ id: materialId, filePath: it.filePath, name: it.name, durationUs: it.durationUs })
    );
    audioSegments.push(
      buildAudioSegment({ id: uuidv4(), materialId, startUs: it.startUs, durationUs: it.durationUs })
    );
  }

  const textSegments = [];
  for (const it of textItems) {
    const materialId = uuidv4();
    materials.texts.push(buildTextMaterial({ id: materialId, text: it.text }));
    textSegments.push(
      buildTextSegment({ id: uuidv4(), materialId, startUs: it.startUs, durationUs: it.durationUs })
    );
  }

  const tracks = [
    {
      attribute: 0,
      flag: 0,
      id: uuidv4(),
      is_default_name: true,
      name: '',
      segments: videoSegments,
      type: 'video',
    },
  ];
  if (audioSegments.length) {
    tracks.push({
      attribute: 0,
      flag: 0,
      id: uuidv4(),
      is_default_name: true,
      name: '对白配音',
      segments: audioSegments,
      type: 'audio',
    });
  }
  if (textSegments.length) {
    tracks.push({
      attribute: 0,
      flag: 0,
      id: uuidv4(),
      is_default_name: true,
      name: '旁白字幕',
      segments: textSegments,
      type: 'text',
    });
  }

  return {
    canvas_config: { height: size.height, ratio: 'original', width: size.width },
    color_space: 0,
    config: {
      adjust_max_index: 1,
      attachment_info: [],
      combination_max_index: 1,
      export_range: null,
      extract_audio_last_index: 1,
      lyrics_recognition_id: '',
      lyrics_sync: true,
      lyrics_taskinfo: [],
      maintrack_adsorb: true,
      material_save_mode: 0,
      multi_language_current: 'none',
      multi_language_list: [],
      multi_language_main: 'none',
      multi_language_mode: 'none',
      original_sound_last_index: 1,
      record_audio_last_index: 1,
      sticker_max_index: 1,
      subtitle_keywords_config: null,
      subtitle_recognition_id: '',
      subtitle_sync: true,
      subtitle_taskinfo: [],
      system_font_list: [],
      video_mute: false,
      zoom_info_params: null,
    },
    cover: null,
    create_time: nowSec,
    duration: durationUs,
    extra_info: null,
    fps: FPS,
    free_render_index_mode_on: false,
    group_container: null,
    id: uuidv4(),
    keyframe_graph_list: [],
    keyframes: {
      adjusts: [],
      audios: [],
      effects: [],
      filters: [],
      handwrites: [],
      stickers: [],
      texts: [],
      videos: [],
    },
    last_modified_platform: PLATFORM,
    lyrics_effects: [],
    materials,
    mutable_config: null,
    name: draftName,
    new_version: '110.0.0',
    platform: PLATFORM,
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks,
    uneven_animation_template_info: { composition: '', content: '', order: '', sub_template: '' },
    update_time: nowSec,
    version: 360000,
  };
}

/**
 * 导出一集为剪映草稿 ZIP
 * @returns {{ buffer: Buffer, filename: string, draftName: string, count: number }}
 */
function exportEpisodeDraft(db, cfg, log, episodeId) {
  const storageRoot = getStoragePath(cfg);
  const ep = db.prepare(
    'SELECT id, drama_id, episode_number FROM episodes WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(episodeId));
  if (!ep) throw new Error('剧集不存在');

  const drama = db.prepare('SELECT title, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(ep.drama_id);
  let metadata = {};
  try {
    metadata = drama?.metadata
      ? (typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : drama.metadata)
      : {};
  } catch (_) {}

  const size = canvasSize(metadata.aspect_ratio, metadata.resolution || metadata.video_resolution);

  const storyboards = db.prepare(
    `SELECT id, storyboard_number, title, duration, local_path, dialogue, narration,
            audio_local_path, narration_audio_local_path
     FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC`
  ).all(Number(episodeId));

  const title = drama?.title || '短剧';
  const epLabel = `第${ep.episode_number ?? ep.id}集`;
  const draftName = `${title}_${epLabel}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const draftRoot = getJianyingDraftRoot(cfg);
  // 草稿解压后的目标目录；能确定剪映草稿根目录时，素材以该目录下的绝对路径写入 JSON
  const draftDirAbs = draftRoot ? path.join(draftRoot, draftName) : null;
  const mediaDirAbs = draftDirAbs ? path.join(draftDirAbs, 'materials') : null;

  const videoItems = [];
  const audioItems = [];
  const textItems = [];
  let cursorUs = 0;
  let skipped = 0;

  for (const sb of storyboards) {
    const videoAbs = resolveStoryboardVideoAbs(db, storageRoot, sb);
    if (!videoAbs) {
      skipped += 1;
      continue;
    }
    const slotSec = Math.max(0.2, Number(sb.duration) || 5);
    const actualSec = ffprobeDurationSec(videoAbs);
    const segSec = Math.max(0.2, Math.min(slotSec, actualSec || slotSec));
    const segUs = Math.round(segSec * US);
    const no = sb.storyboard_number ?? sb.id;
    const baseName = `sb_${String(no).padStart(3, '0')}`;
    const videoSize = ffprobeVideoSize(videoAbs) || size;
    const videoName = `${baseName}${path.extname(videoAbs) || '.mp4'}`;

    videoItems.push({
      srcPath: videoAbs,
      filePath: mediaDirAbs ? path.join(mediaDirAbs, videoName) : videoAbs,
      name: videoName,
      startUs: cursorUs,
      durationUs: segUs,
      width: videoSize.width,
      height: videoSize.height,
    });

    // 对白配音：按分镜槽位对齐铺在音轨上
    const dialAbs = toAbsPath(storageRoot, sb.audio_local_path);
    if (fileExists(dialAbs)) {
      const dialSec = ffprobeDurationSec(dialAbs);
      const dialUs = Math.max(0.2, Math.min(segSec, dialSec || segSec)) * US;
      const dialName = `${baseName}_dialogue${path.extname(dialAbs) || '.mp3'}`;
      audioItems.push({
        srcPath: dialAbs,
        filePath: mediaDirAbs ? path.join(mediaDirAbs, dialName) : dialAbs,
        name: dialName,
        startUs: cursorUs,
        durationUs: Math.round(dialUs),
      });
    }

    // 解说旁白：作为字幕
    const narrText = clampText(sb.narration, 200);
    if (narrText) {
      textItems.push({ text: narrText, startUs: cursorUs, durationUs: segUs });
    }

    cursorUs += segUs;
  }

  if (videoItems.length === 0) {
    throw new Error('本集没有可导出的分镜视频（请先生成分镜视频或手动上传）');
  }

  const content = buildDraftContent({
    draftName,
    size,
    durationUs: cursorUs,
    videoItems,
    audioItems,
    textItems,
  });
  const nowMs = Date.now();
  const meta = {
    draft_cloud_capcut_purchase_info: '',
    draft_cloud_last_action_download: false,
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '',
    draft_cover: '',
    draft_fold_path: draftDirAbs || '',
    draft_id: content.id,
    draft_is_ai_shorts: false,
    draft_is_invisible: false,
    draft_json_file: 'draft_content.json',
    draft_name: draftName,
    draft_new_version: '',
    draft_root_path: draftRoot || '',
    draft_timeline_materials_size: 0,
    draft_type: '',
    tm_draft_cloud_completed: '',
    tm_draft_cloud_modified: 0,
    tm_draft_create: nowMs,
    tm_draft_modified: nowMs,
    tm_draft_removed: 0,
    tm_duration: 0,
  };
  const virtualStore = {
    draft_materials: [
      { type: 0, value: [] },
      { type: 1, value: [] },
      { type: 2, value: [] },
      { type: 3, value: [] },
      { type: 6, value: [] },
      { type: 7, value: [] },
      { type: 8, value: [] },
    ],
    draft_virtual_store: [
      { type: 0, value: [] },
      { type: 1, value: [] },
      { type: 2, value: [] },
    ],
  };

  const zip = new AdmZip();
  const dir = draftName;
  zip.addFile(`${dir}/draft_content.json`, Buffer.from(JSON.stringify(content, null, 2), 'utf8'));
  zip.addFile(`${dir}/draft_meta_info.json`, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
  zip.addFile(`${dir}/draft_virtual_store.json`, Buffer.from(JSON.stringify(virtualStore, null, 2), 'utf8'));

  // 将分镜视频与配音一并打包进草稿目录，避免依赖后端存储路径
  const addedMedia = new Set();
  for (const it of [...videoItems, ...audioItems]) {
    if (!fileExists(it.srcPath) || addedMedia.has(it.name)) continue;
    addedMedia.add(it.name);
    zip.addLocalFile(it.srcPath, `${dir}/materials`, it.name);
  }

  zip.addFile(
    `${dir}/README.txt`,
    Buffer.from(
      [
        '剪映草稿导出说明',
        '',
        `1. 解压后将整个「${dir}」文件夹放入剪映草稿目录：`,
        '   - macOS: ~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/',
        '   - Windows: %LOCALAPPDATA%/JianyingPro/User Data/Projects/com.lveditor.draft/',
        '2. 重新打开剪映，在「草稿」列表即可看到本项目。',
        '3. 分镜视频与配音已随草稿打包在 materials/ 目录中，无需依赖后端存储文件。',
        '',
        `分镜数量: ${videoItems.length}${skipped ? `（跳过无视频分镜 ${skipped} 个）` : ''}`,
        `素材文件: ${addedMedia.size} 个`,
      ].join('\n'),
      'utf8'
    )
  );

  if (log) {
    log.info('Jianying draft exported', {
      episode_id: Number(episodeId),
      storyboards: videoItems.length,
      skipped,
      duration_us: cursorUs,
    });
  }
  return {
    buffer: zip.toBuffer(),
    filename: `${draftName}.zip`,
    draftName,
    count: videoItems.length,
  };
}

module.exports = { exportEpisodeDraft };
