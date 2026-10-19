import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { encode, command, ffmpeg, ffprobe } from './media.mjs';

const host = process.env.HOST || '127.0.0.1';
const secret = process.env.API_TOKEN || '';
if ((!['127.0.0.1','localhost','::1'].includes(host) || process.env.NODE_ENV === 'production') && secret.length < 24) throw new Error('공개 서버에는 24자 이상의 API_TOKEN이 필요합니다.');
const origins = new Set((process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173').split(',').map(value => value.trim()));
const root = await mkdtemp(path.join(os.tmpdir(), 'dellow-video-'));
const jobs = new Map();
const maxJobs = 4, ttl = 60 * 60 * 1000;
let running = false;
const app = express(); app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = req.headers.origin;
  if (origin && !origins.has(origin)) return res.status(403).json({ error: '허용되지 않은 웹사이트입니다. ALLOWED_ORIGINS를 확인하세요.' });
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');
  res.setHeader('Access-Control-Expose-Headers','Content-Disposition,Content-Length,X-Content-SHA256');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const auth = (req, res, next) => {
  if (secret && !equal(req.headers.authorization || '', `Bearer ${secret}`)) return res.status(401).json({ error: '변환 서버의 접속 키를 확인해 주세요.' });
  next();
};
app.get('/health', (_req,res) => res.json({ ok: true, service: 'dellow-native-ffmpeg', version: 1 }));
app.get('/v1/connection', auth, (_req,res) => res.json({ ok: true, service: 'dellow-native-ffmpeg' }));
async function destroy(job) {
  job.cancelled = true; job.child?.kill('SIGKILL'); jobs.delete(job.id);
  // Processing paths clean up after child close, avoiding a deletion/write race.
  if (!['processing','verifying'].includes(job.status)) await rm(job.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
async function pump() {
  if (running) return;
  const job = [...jobs.values()].find(job => job.status === 'queued'); if (!job) return;
  running = true; job.status = 'processing';
  try { await encode(job); if (!job.cancelled) { job.status = 'ready'; job.progress = 100; } }
  catch (error) { if (!job.cancelled) { job.status = 'failed'; job.error = '영상을 변환하지 못했습니다. MP4 원본과 선택 구간을 확인하고 다시 시도하세요.'; console.error(`job ${job.id}: ${error.message}`); } }
  finally {
    // Input and caption never need to remain after processing.
    if (job.cancelled) await rm(job.dir, { recursive: true, force: true });
    else { await rm(job.input, { force: true }); if (job.overlay) await rm(job.overlay, { force: true }); }
    running = false; void pump();
  }
}
const upload = multer({ storage: multer.diskStorage({ destination: (req,_file,cb) => cb(null, req.videoJob.dir), filename: (_req,file,cb) => cb(null, file.fieldname === 'video' ? 'input.mp4' : 'subtitle.png') }), limits: { fileSize: 500 * 1024 * 1024, files: 2, fields: 2, fieldSize: 128, parts: 4 } }).fields([{ name: 'video', maxCount: 1 }, { name: 'subtitle', maxCount: 1 }]);
app.post('/v1/jobs', auth, async (req,res,next) => {
  if (jobs.size >= maxJobs) return res.status(429).json({ error: '서버 작업 공간이 가득 찼습니다. 완료한 작업을 지우거나 잠시 후 다시 시도하세요.' });
  const id = randomBytes(18).toString('hex');
  const job = { id, dir: path.join(root,id), created: Date.now(), status: 'uploading', progress: 0, ticket: randomBytes(32).toString('hex') };
  jobs.set(id,job); req.videoJob = job;
  try { await mkdir(job.dir); } catch (error) { jobs.delete(id); return next(error); }
  req.once('aborted', () => { void destroy(job); });
  upload(req,res, async error => {
    try {
      if (error) throw new Error('파일 업로드에 실패했습니다. MP4 500 MB 이하, 파일 개수와 네트워크를 확인해 주세요.');
      if (job.cancelled) { await rm(job.dir,{recursive:true,force:true}); return; }
      const start = Number(req.body.start), end = Number(req.body.end);
      if (!req.files?.video?.[0] || req.body.start == null || req.body.end == null || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 600) throw new Error('MP4와 0~600초 길이의 올바른 자르기 구간이 필요합니다.');
      job.start = start; job.end = end; job.input = req.files.video[0].path; job.overlay = req.files.subtitle?.[0]?.path;
      job.status = 'queued'; res.status(202).json({ id }); void pump();
    } catch (failure) { await destroy(job); if (!res.headersSent && !req.aborted) res.status(400).json({ error: failure.message }); }
  });
});
app.get('/v1/jobs/:id', auth, (req,res) => {
  const job = jobs.get(req.params.id); if (!job) return res.status(404).json({error:'작업이 없거나 만료되었습니다.'});
  res.json({ id: job.id, status: job.status, progress: job.progress, error: job.error, ...(job.status === 'ready' ? { downloadPath: `/v1/jobs/${job.id}/file?ticket=${job.ticket}`, report: job.report } : {}) });
});
app.get('/v1/jobs/:id/file', (req,res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'ready' || !equal(String(req.query.ticket || ''), job.ticket)) return res.status(404).json({error:'파일이 없거나 다운로드 주소가 만료되었습니다.'});
  res.setHeader('Content-Type','video/mp4');
  res.setHeader('Content-Disposition',`attachment; filename="DELLOW_${job.id}.mp4"`);
  res.setHeader('X-Content-SHA256',job.report.sha256);
  job.downloads=(job.downloads || 0)+1;
  res.sendFile(job.output, { acceptRanges: true, cacheControl: false }, error => { job.downloads-=1; if (error && !res.headersSent) res.status(500).end(); });
});
app.delete('/v1/jobs/:id', auth, async (req,res) => { const job=jobs.get(req.params.id); if(job) await destroy(job); res.sendStatus(204); });
app.use((error,_req,res,_next) => { console.error(error.message); if(!res.headersSent) res.status(500).json({error:'변환 서버에서 오류가 발생했습니다.'}); });
const cleanup = setInterval(() => { for(const job of jobs.values()) if(Date.now()-job.created>ttl && !job.downloads) void destroy(job).catch(error=>console.error('Cleanup:',error.message)); },60000); cleanup.unref();
await command(ffmpeg, ['-version']); await command(ffprobe, ['-version']);
const server=app.listen(Number(process.env.PORT || 8787),host,()=>console.log(`DELLOW video API ready: http://${host}:${server.address().port}`));
server.requestTimeout=10*60*1000;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{clearInterval(cleanup);server.close();for(const job of jobs.values()) await destroy(job);setTimeout(()=>process.exit(0),1000).unref();});
