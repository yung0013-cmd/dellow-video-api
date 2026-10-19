import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { open, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
function binary(env, fallback, module) {
  if (process.env[env]) return process.env[env];
  try { const value = require(module); return typeof value === 'string' ? value : value.path; } catch { return fallback; }
}
export const ffmpeg = binary('FFMPEG_PATH', 'ffmpeg', 'ffmpeg-static');
export const ffprobe = binary('FFPROBE_PATH', 'ffprobe', 'ffprobe-static');
export function command(executable, args, job, onData) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) return reject(new Error('작업을 취소했습니다.'));
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (job) job.child = child;
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2000000); onData?.(String(data)); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout); if (job) job.child = null;
      if (code !== 0 || job?.cancelled) reject(new Error(job?.cancelled ? '작업을 취소했습니다.' : `FFmpeg 처리 실패: ${stderr.slice(-1500)}`));
      else resolve(stdout);
    });
  });
}
export async function probe(file, job) {
  return JSON.parse(await command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], job));
}
export function dimensions(width, height) {
  const scale = Math.min(1, 1280 / Math.max(width, height), 720 / Math.min(width, height));
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}
async function checkBoxes(file) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size, boxes = []; let position = 0;
    while (position + 8 <= size) {
      const header = Buffer.alloc(16); await handle.read(header, 0, Math.min(16, size - position), position);
      let length = header.readUInt32BE(0); const type = header.toString('ascii', 4, 8);
      if (length === 1) length = Number(header.readBigUInt64BE(8));
      if (length === 0) length = size - position;
      if (!Number.isSafeInteger(length) || length < 8 || position + length > size) throw new Error('손상된 MP4 구조입니다.');
      boxes.push(type); position += length;
    }
    if (position !== size || boxes[0] !== 'ftyp' || !boxes.includes('moov') || !boxes.includes('mdat') || boxes.includes('moof') || boxes.indexOf('moov') > boxes.indexOf('mdat')) throw new Error('MP4 faststart 구조 검증에 실패했습니다.');
    return boxes;
  } finally { await handle.close(); }
}
export async function encode(job) {
  const source = job.input;
  const handle = await open(source, 'r'); const header = Buffer.alloc(12);
  try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
  if (header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('실제 MP4 원본 파일이 필요합니다.');
  const info = JSON.parse(await command(ffprobe, ['-v', 'error', '-f', 'mov', '-show_streams', '-show_format', '-of', 'json', source], job));
  const video = info.streams.find(stream => stream.codec_type === 'video');
  const length = Number(info.format.duration);
  if (!video || !Number.isFinite(length) || job.end > length + 0.05 || job.start >= length) throw new Error('영상 길이와 자르기 구간을 확인해 주세요.');
  const rotation = Math.abs(Number(video.side_data_list?.find(item => item.rotation != null)?.rotation || video.tags?.rotate || 0)) % 180;
  const [sarN, sarD] = (video.sample_aspect_ratio || '1:1').split(':').map(Number);
  const displayWidth = Math.round(video.width * (sarN > 0 && sarD > 0 ? sarN / sarD : 1));
  const outputSize = dimensions(rotation === 90 ? video.height : displayWidth, rotation === 90 ? displayWidth : video.height);
  if (job.overlay) {
    if ((await stat(job.overlay)).size > 5 * 1024 * 1024) throw new Error('자막 이미지가 너무 큽니다.');
    const overlayHeader = await readFile(job.overlay);
    if (!overlayHeader.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('자막은 PNG 이미지여야 합니다.');
    if (overlayHeader.length < 24 || overlayHeader.readUInt32BE(16) > 1280 || overlayHeader.readUInt32BE(20) > 1280) throw new Error('자막 이미지 크기가 허용 범위를 초과합니다.');
  }
  const hasAudio = info.streams.some(stream => stream.codec_type === 'audio');
  const output = path.join(job.dir, 'output.mp4');
  const filter = `scale=${outputSize.width}:${outputSize.height}:out_range=tv,setsar=1,fps=30,format=yuv420p,setparams=range=limited`;
  const filters = job.overlay
    ? ['-filter_complex', `[0:v:0]${filter}[base];[1:v:0]scale=${outputSize.width}:${outputSize.height}[caption];[base][caption]overlay=0:0:format=auto,format=yuv420p,setparams=range=limited[outv]`, '-map', '[outv]']
    : ['-vf', filter, '-map', '0:v:0'];
  const args = ['-hide_banner', '-nostdin', '-y', '-threads', '2', '-ss', String(job.start), '-f', 'mov', '-i', source,
    ...(job.overlay ? ['-i', job.overlay] : []),
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']),
    '-t', String(job.end - job.start), '-filter_threads', '1', '-filter_complex_threads', '1', ...filters,
    '-map', hasAudio ? '0:a:0' : `${job.overlay ? 2 : 1}:a:0`, '-sn', '-dn', '-map_metadata', '-1',
    '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'baseline', '-level:v', '3.1', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-tag:v', 'avc1', '-r', '30', '-g', '60', '-maxrate', '4M', '-bufsize', '8M',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-af', 'aresample=async=1:first_pts=0,apad',
    '-movflags', '+faststart', '-video_track_timescale', '90000', '-f', 'mp4', '-progress', 'pipe:1', output];
  job.command = args.map(value => value === source ? 'input.mp4' : value === job.overlay ? 'subtitle.png' : value === output ? 'output.mp4' : value);
  await command(ffmpeg, args, job, data => {
    for (const match of data.matchAll(/out_time_us=(\d+)/g)) job.progress = Math.min(95, Math.round(Number(match[1]) / 1e6 / (job.end - job.start) * 95));
  });
  job.status = 'verifying';
  const report = await probe(output, job);
  const v = report.streams.find(stream => stream.codec_type === 'video'), a = report.streams.find(stream => stream.codec_type === 'audio');
  if (v?.codec_name !== 'h264' || v.codec_tag_string !== 'avc1' || v.pix_fmt !== 'yuv420p' || v.avg_frame_rate !== '30/1' || v.level > 31 || a?.codec_name !== 'aac' || a.profile !== 'LC' || a.sample_rate !== '48000' || a.channels !== 2 || Math.abs(Number(report.format.duration) - (job.end - job.start)) > 0.15) throw new Error('최종 코덱·길이 검사에 실패했습니다.');
  const boxes = await checkBoxes(output);
  // Fully decode the finished MP4 before making it available to the downloader.
  await command(ffmpeg, ['-v', 'error', '-xerror', '-threads', '2', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], job);
  const hash = createHash('sha256'); for await (const chunk of createReadStream(output)) hash.update(chunk);
  job.report = { video: v, audio: a, duration: report.format.duration, bytes: (await stat(output)).size, sha256: hash.digest('hex'), boxes, fullDecode: 'passed', command: job.command };
  job.output = output;
}
