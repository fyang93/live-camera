import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { Recordings } from './recordings';
import { isPlayable } from './types';
import { byteRange } from './range';

const build = await Bun.build({ entrypoints: [new URL('./app.ts', import.meta.url).pathname], outdir: new URL('./dist', import.meta.url).pathname, target: 'browser', minify: true });
if (!build.success) throw new Error(`Player build failed: ${build.logs.join('\n')}`);
const port = Number(process.env.PORT || 8080);
const rtcPort = Number(process.env.RTC_PORT || 8889);
const codec = process.env.RECORDING_CODEC || 'h265';
if (codec !== 'h265' && codec !== 'h264') throw new Error('RECORDING_CODEC must be h265 or h264');
const recordings = new Recordings(
  resolve(process.env.RECORDINGS_DIR || new URL('../recordings', import.meta.url).pathname),
  process.env.RECORDING_SOURCE || 'rtsp://127.0.0.1:8554/cam', codec,
  Number(process.env.RECORDING_SEGMENT_SECONDS || 7200),
);
let ready = false, closing = false;
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['dist/app.js', 'text/javascript']],
]);
function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}
function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true; // CLI clients on the trusted network.
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
const server = http.createServer(async (req, res) => {
  try {
    if (!ready || closing) { json(res, 503, { error: '服务正在启动或停止' }); return; }
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    const method = req.method || 'GET';
    if (!['GET', 'HEAD'].includes(method) && !sameOrigin(req)) { json(res, 403, { error: '不允许跨站操作' }); return; }
    if (path === '/api/recordings' && method === 'GET') { await recordings.refresh(); json(res, 200, recordings.list()); return; }
    if (path === '/api/recordings' && method === 'POST') {
      req.resume(); json(res, 202, await recordings.start()); return;
    }
    const stop = path.match(/^\/api\/recordings\/([\da-f-]{36})\/stop$/);
    if (stop && method === 'POST') {
      req.resume(); json(res, 200, await recordings.stop(stop[1])); return;
    }
    const remove = path.match(/^\/api\/recordings\/([\da-f-]{36}-\d{5,})$/);
    if (remove && method === 'DELETE') {
      req.resume(); await recordings.remove(remove[1]); json(res, 200, recordings.list()); return;
    }
    const media = path.match(/^\/recordings\/([\da-f-]{36}-\d{5,})\.mp4$/);
    if (media && ['GET', 'HEAD'].includes(method)) {
      const item = recordings.items.get(media[1]);
      if (!item || !isPlayable(item)) { json(res, 404, { error: '录像尚不可播放' }); return; }
      const file = recordings.file(item.id), size = (await stat(file)).size;
      const range = byteRange(req.headers.range, size);
      if (range === null) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache' };
      if (req.headers.range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      headers['Content-Length'] = range.end - range.start + 1;
      res.writeHead(req.headers.range ? 206 : 200, headers);
      if (method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(file, range);
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
    }
    if (path.startsWith('/rtc/cam/') && ['POST', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
      const upstream = http.request({ hostname: '127.0.0.1', port: rtcPort, path: req.url!.slice(4), method,
        headers: { ...req.headers, host: `127.0.0.1:${rtcPort}` } }, response => {
        const headers = { ...response.headers };
        if (headers.location) {
          const location = new URL(headers.location, `http://localhost${req.url!.slice(4)}`);
          headers.location = '/rtc' + location.pathname + location.search;
        }
        res.writeHead(response.statusCode || 502, headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Stream unavailable'); });
      res.on('close', () => upstream.destroy()); req.pipe(upstream); return;
    }
    const file = files.get(path);
    if (file && ['GET', 'HEAD'].includes(method)) {
      const body = await readFile(new URL(file[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' }).end(method === 'HEAD' ? undefined : body); return;
    }
    json(res, 404, { error: '未找到' });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : '操作失败' });
    else res.destroy();
  }
});
// Bind before recovering metadata: a second process on the same port must not touch active recordings.
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
await recordings.init(); ready = true;
console.log(`Player listening on :${port}; manual recordings: ${recordings.directory} (${codec}); recording OFF`);
async function shutdown(): Promise<void> {
  if (closing) return; closing = true;
  if (recordings.active) await recordings.stop(recordings.active.item.id);
  server.close(); server.closeAllConnections(); process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
