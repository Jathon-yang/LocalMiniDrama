const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const videoMergeService = require('../src/services/videoMergeService');

const warnings = [];
const log = { info() {}, warn: (...a) => warnings.push(a), error() {}, debug() {} };

describe('buildConcatArgs', () => {
  it('uses stream copy by default (fast, lossless)', () => {
    const args = videoMergeService.buildConcatArgs('/tmp/list.txt', '/tmp/out.mp4');
    assert.deepEqual(args, ['-f', 'concat', '-safe', '0', '-i', '/tmp/list.txt', '-c', 'copy', '-y', '/tmp/out.mp4']);
  });

  it('uses re-encode args when transcode is requested (mixed-parameter clips fallback)', () => {
    const args = videoMergeService.buildConcatArgs('/tmp/list.txt', '/tmp/out.mp4', true);
    assert.equal(args.includes('-c:v'), true);
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.equal(args.includes('-movflags'), true);
    assert.equal(args.includes('-c'), false);
    assert.equal(args[args.length - 1], '/tmp/out.mp4');
  });
});

describe('runFfmpegConcat', () => {
  it('returns false when clips cannot be concatenated (no ffmpeg / missing inputs)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-concat-'));
    const outputPath = path.join(dir, 'merged.mp4');
    const missing = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];

    const ok = videoMergeService.runFfmpegConcat(missing, outputPath, log);

    assert.equal(ok, false);
    assert.equal(fs.existsSync(outputPath), false);
    // concat list 文件必须被清理，不残留临时文件
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith('concat_list_')),
      []
    );
  });
});
