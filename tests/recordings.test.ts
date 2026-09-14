import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recordings } from '../web/recordings';
import { isPlayable } from '../web/types';

const available = !!Bun.which('ffmpeg') && !!Bun.which('mediamtx') && !!Bun.which('ffprobe');
describe.skipIf(!available)('manual recording integration (isolated synthetic camera)', () => {
  let directory: string;
  let mtx: ReturnType<typeof Bun.spawn>, publisher: ReturnType<typeof Bun.spawn>;
  const source = 'rtsp://127.0.0.1:29554/cam';
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'live-camera-test-'));
    await writeFile(join(directory, 'mediamtx.yml'), 'logLevel: error\nrtspAddress: 127.0.0.1:29554\nrtspTransports: [tcp]\nhls: false\nwebrtc: false\nrtmp: false\nsrt: false\nmoq: false\npaths:\n  cam:\n    source: publisher\n');
    mtx = Bun.spawn(['mediamtx', join(directory, 'mediamtx.yml')], { stdout: 'inherit', stderr: 'inherit' });
    await Bun.sleep(700);
    publisher = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', source], { stdout: 'ignore', stderr: 'inherit' });
    await Bun.sleep(1200);
    expect(mtx.exitCode).toBeNull(); expect(publisher.exitCode).toBeNull();
  });
  afterAll(async () => {
    publisher?.kill(); await publisher?.exited;
    mtx?.kill(); await mtx?.exited;
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  test('off by default, continuous rollovers, stop, restart recovery and deletion', async () => {
    const path = join(directory, 'recordings');
    const store = new Recordings(path, source, 'h264', 2);
    await store.init();
    expect(store.list().active).toBeNull(); expect(await readdir(path)).toHaveLength(0);
    try {
      const first = await store.start(); expect(first.active).not.toBeNull();
      await expect(store.start()).rejects.toThrow('已有录像');
      await Bun.sleep(9500); await store.refresh();
      const rolling = store.list();
      expect(rolling.active).toBe(first.active);
      expect(rolling.recordings.filter(isPlayable).length).toBeGreaterThanOrEqual(2);
      for (const item of rolling.recordings.filter(isPlayable)) {
        expect(item.duration).toBeLessThanOrEqual(2.15);
        expect(item.bytes).toBeGreaterThan(1000);
      }
      // A stale stop from a different browser must not stop the current session.
      await store.stop('not-the-current-session'); expect(store.list().active).toBe(first.active);
      await store.stop(first.active!); expect(store.list().active).toBeNull();
      const stopped = store.list(); expect(stopped.recordings.every(isPlayable)).toBe(true);
      const restored = new Recordings(path, source, 'h264', 2); await restored.init();
      expect(restored.list().active).toBeNull(); expect(restored.list().recordings.length).toBe(stopped.recordings.length);
      const victim = restored.list().recordings[0]; await restored.remove(victim.id);
      await restored.refresh(); expect(restored.items.has(victim.id)).toBe(false);
      const again = new Recordings(path, source, 'h264', 2); await again.init(); expect(again.items.has(victim.id)).toBe(false);
      expect(() => store.file('../../etc/passwd')).toThrow();
    } finally { if (store.active) await store.stop(store.active.item.id); }
  }, 25000);
  test('recorder stops when the parent control pipe closes', async () => {
    const store = new Recordings(join(directory, 'parent-death'), source, 'h264', 2);
    await store.init();
    try {
      await store.start(); await Bun.sleep(5000);
      const active = store.active!;
      active.child.stdin!.end(); // Same EOF received when the parent process dies.
      await active.done;
      expect(store.list().active).toBeNull();
      expect(store.list().recordings.filter(isPlayable).length).toBeGreaterThan(0);
    } finally { if (store.active) await store.stop(store.active.item.id); }
  }, 15000);
  test.skipIf(process.env.TEST_HEVC !== '1')('HEVC hardware recording and fragmented MP4', async () => {
    const store = new Recordings(join(directory, 'hevc'), source, 'h265', 2); await store.init();
    try {
      const first = await store.start(); await Bun.sleep(7500); await store.stop(first.active!);
      const ready = store.list().recordings.filter(isPlayable); expect(ready.length).toBeGreaterThanOrEqual(2);
      const result = Bun.spawn(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,codec_tag_string', '-of', 'json', store.file(ready[0].id)]);
      const info = await new Response(result.stdout).json();
      expect(info.streams[0].codec_name).toBe('hevc'); expect(info.streams[0].codec_tag_string).toBe('hvc1');
    } finally { if (store.active) await store.stop(store.active.item.id); }
  }, 20000);
});
