import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Recording, RecordingCodec, RecordingList, RecordingStatus } from './types';

const exec = promisify(execFile);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const UUID = /^[\da-f-]{36}$/;
const PART = /^(\d{5,})\.mp4$/;
interface Session {
  id: string;
  startedAt: number;
  codec: RecordingCodec;
  status: RecordingStatus;
  segmentSeconds: number;
  error?: string;
  deleted?: string[];
}
interface Active {
  item: Session;
  child: ChildProcess;
  done: Promise<void>;
  stopping: boolean;
  elapsed: number;
  stderr: string;
  spaceTimer?: ReturnType<typeof setInterval>;
  killTimer?: ReturnType<typeof setTimeout>;
}
export class Recordings {
  items = new Map<string, Recording>();
  sessions = new Map<string, Session>();
  active: Active | null = null;
  busy = false;
  private refreshing: Promise<void> | null = null;
  constructor(public directory: string, public source: string, public codec: RecordingCodec = 'h265', public segmentSeconds = 7200) {
    if (!Number.isInteger(segmentSeconds) || segmentSeconds < 2 || segmentSeconds > 43200) throw new Error('分段时长必须为 2–43200 秒');
  }
  private async save(session: Session): Promise<void> {
    const path = join(this.directory, session.id, 'session.json');
    await writeFile(`${path}.tmp`, JSON.stringify(session, null, 2));
    await rename(`${path}.tmp`, path);
  }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) {
      if (!UUID.test(name)) continue;
      try {
        const session = JSON.parse(await readFile(join(this.directory, name, 'session.json'), 'utf8')) as Session;
        if (session.id !== name || !Number.isFinite(session.startedAt)) continue;
        if (['starting', 'recording', 'stopping'].includes(session.status)) {
          session.status = 'interrupted'; session.error = '上次录像意外中断，已保留可恢复的分段';
          await this.save(session);
        }
        this.sessions.set(name, session);
      } catch (error) { console.warn(`Cannot read session ${name}:`, message(error)); }
    }
    await this.refresh();
  }
  file(id: string): string {
    const match = /^([\da-f-]{36})-(\d{5,})$/.exec(id);
    if (!match) throw new Error('无效录像 ID');
    return join(this.directory, match[1], `${match[2]}.mp4`);
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async scan(): Promise<void> {
    for (const session of this.sessions.values()) {
      const directory = join(this.directory, session.id);
      const names = (await readdir(directory)).filter(name => PART.test(name) && !session.deleted?.includes(name)).sort();
      // The segment muxer writes a CSV entry only after closing that segment.
      const closed = new Map<string, { start: number; duration: number }>();
      try {
        for (const line of (await readFile(join(directory, 'segments.csv'), 'utf8')).trim().split('\n')) {
          const match = /(?:^|\/)(\d{5,}\.mp4)"?,([\d.]+),([\d.]+)$/.exec(line);
          if (match) closed.set(match[1], { start: Number(match[2]), duration: Number(match[3]) - Number(match[2]) });
        }
      } catch { /* No complete segment yet. */ }
      const active = this.active?.item.id === session.id ? this.active : null;
      if (active && names.length === 0) {
        const id = `${session.id}-00000`;
        this.items.set(id, { id, startedAt: session.startedAt, endedAt: null, duration: 0, bytes: 0, codec: session.codec, status: active.stopping ? 'stopping' : 'starting' });
      }
      for (const name of names) {
        const id = `${session.id}-${name.slice(0, -4)}`;
        const previous = this.items.get(id);
        if (previous && ['ready', 'interrupted', 'failed'].includes(previous.status)) continue;
        const info = closed.get(name);
        const isOpen = !!active && !info;
        const start = info?.start ?? Number(name.slice(0, -4)) * session.segmentSeconds;
        let duration = info?.duration ?? Math.max(0, (active?.elapsed || 0) - start);
        let status: RecordingStatus = isOpen ? active.stopping ? 'stopping' : duration > 0 ? 'recording' : 'starting' : info ? 'ready' : 'interrupted';
        if (!isOpen && !info) {
          try {
            const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', this.file(id)], { timeout: 15000 });
            duration = Number(JSON.parse(stdout).format?.duration) || 0;
          } catch { duration = 0; }
        }
        if (!isOpen && duration <= 0) status = 'failed';
        const item: Recording = { id, startedAt: session.startedAt + start * 1000, endedAt: isOpen ? null : session.startedAt + (start + duration) * 1000,
          duration, bytes: (await stat(this.file(id))).size, codec: session.codec, status };
        if (session.error) item.error = session.error;
        if (status === 'failed' && !item.error) item.error = '没有可播放的视频，请检查推流或编码器';
        this.items.set(id, item);
      }
      if (!active && names.length === 0 && !session.deleted?.includes('00000.mp4')) {
        const id = `${session.id}-00000`;
        this.items.set(id, { id, startedAt: session.startedAt, endedAt: session.startedAt, duration: 0, bytes: 0, codec: session.codec, status: 'failed', error: session.error || '录像过短或没有收到视频' });
      }
    }
  }
  list(): RecordingList {
    return { active: this.active?.item.id || null, maxSegmentSeconds: this.segmentSeconds, recordings: [...this.items.values()].sort((a, b) => b.startedAt - a.startedAt) };
  }
  async checkSpace(): Promise<void> {
    const fs = await statfs(this.directory);
    if (fs.bavail * fs.bsize < 1024 ** 3) throw new Error('磁盘可用空间不足 1 GiB，已停止或拒绝录像');
  }
  async start(): Promise<RecordingList> {
    if (this.active || this.busy) throw new Error('已有录像正在进行');
    this.busy = true;
    try {
      await this.checkSpace();
      const session: Session = { id: randomUUID(), startedAt: Date.now(), codec: this.codec, status: 'starting', segmentSeconds: this.segmentSeconds };
      const directory = join(this.directory, session.id);
      await mkdir(directory); await this.save(session); this.sessions.set(session.id, session);
      const encoder = this.codec === 'h265'
        ? ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '28', '-b:v', '1500k', '-maxrate', '2M', '-bufsize', '4M', '-tag:v', 'hvc1']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-maxrate', '2M', '-bufsize', '4M'];
      // A continuous encoder + segment muxer rolls files at keyframes without reopening the source.
      const child = spawn('bun', [new URL('./record-worker.ts', import.meta.url).pathname, '-hide_banner', '-loglevel', 'warning', '-nostdin',
        '-rtsp_transport', 'tcp', '-timeout', '15000000', '-i', this.source,
        '-map', '0:v:0', '-an', '-vf', 'fps=20,setpts=PTS-STARTPTS', ...encoder, '-pix_fmt', 'yuv420p', '-g', '40', '-bf', '0',
        '-force_key_frames', `expr:gte(t,n_forced*${this.segmentSeconds})`,
        '-f', 'segment', '-segment_time', String(this.segmentSeconds), '-reset_timestamps', '1',
        '-segment_format', 'mp4', '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
        '-segment_list', join(directory, 'segments.csv'), '-segment_list_type', 'csv',
        '-progress', 'pipe:1', join(directory, '%05d.mp4')], { stdio: ['pipe', 'pipe', 'pipe'] });
      const active: Active = { item: session, child, done: Promise.resolve(), stopping: false, elapsed: 0, stderr: '' };
      this.active = active;
      let progress = '';
      child.stdout.on('data', chunk => {
        progress += chunk.toString(); const lines = progress.split('\n'); progress = lines.pop() || '';
        for (const line of lines) if (line.startsWith('out_time_us=')) {
          const duration = Number(line.slice(12)) / 1e6;
          if (Number.isFinite(duration) && duration > 0) { active.elapsed = duration; if (!active.stopping) session.status = 'recording'; }
        }
      });
      child.stderr.on('data', chunk => { active.stderr = (active.stderr + chunk).slice(-4000); });
      child.on('error', error => { session.error = error.message; });
      active.done = new Promise<void>(resolve => child.once('close', async code => {
        clearInterval(active.spaceTimer); clearTimeout(active.killTimer);
        session.status = active.stopping || code === 0 ? 'ready' : 'failed';
        if (session.status === 'failed') {
          session.error ||= '录像进程意外退出，请检查推流和编码器'; console.error('Recorder exited:', active.stderr);
        }
        // Serialize against any ongoing list scan before finalizing the last file.
        if (this.refreshing) await this.refreshing.catch(console.error);
        if (this.active === active) this.active = null;
        try { await this.save(session); await this.refresh(); } catch (error) { console.error('Cannot finalize recording:', error); }
        resolve();
      }));
      active.spaceTimer = setInterval(async () => {
        try { await this.checkSpace(); }
        catch (error) { session.error = message(error); void this.stop(session.id).catch(console.error); }
      }, 10000);
      active.spaceTimer.unref();
      await this.refresh(); return this.list();
    } finally { this.busy = false; }
  }
  async stop(id: string): Promise<RecordingList> {
    const active = this.active;
    if (!active || active.item.id !== id) return this.list();
    if (!active.stopping) {
      active.stopping = true; active.item.status = 'stopping'; active.child.kill('SIGINT');
      active.killTimer = setTimeout(() => active.child.kill('SIGKILL'), 10000);
    }
    await active.done; return this.list();
  }
  async remove(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error('录像不存在');
    const session = this.sessions.get(id.slice(0, 36))!;
    if (this.active?.item.id === session.id) throw new Error('请先停止这次录像再删除分段');
    // Block starts/deletes while session metadata is being changed.
    if (this.busy) throw new Error('请稍后重试');
    this.busy = true;
    try {
      if (this.refreshing) await this.refreshing;
      await unlink(this.file(id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      session.deleted = [...(session.deleted || []), `${id.slice(37)}.mp4`];
      await this.save(session); this.items.delete(id);
    } finally { this.busy = false; }
  }
}
