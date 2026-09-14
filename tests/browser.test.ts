import { test, expect } from 'bun:test';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.CHROME_PATH || Bun.which('google-chrome') || Bun.which('chromium');
test.skipIf(!chrome || !Bun.which('ffmpeg'))('mobile player, persisted library, MP4 seeking and range API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-camera-browser-'));
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const sessionDirectory = join(directory, id); await mkdir(sessionDirectory);
  const fixture = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=20', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '20', '-bf', '0', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', join(sessionDirectory, '00000.mp4')]);
  expect(await fixture.exited).toBe(0);
  await writeFile(join(sessionDirectory, 'session.json'), JSON.stringify({ id, startedAt: Date.now() - 60000, codec: 'h264', status: 'ready', segmentSeconds: 7200 }));
  await writeFile(join(sessionDirectory, 'segments.csv'), '00000.mp4,0,4\n');
  const server = Bun.spawn(['bun', 'web/server.ts'], { env: { ...process.env, PORT: '28680', RTC_PORT: '28689', RECORDINGS_DIR: directory, RECORDING_CODEC: 'h264' }, stdout: 'ignore', stderr: 'inherit' });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch('http://127.0.0.1:28680/api/recordings')).ok) break; } catch {}
      await Bun.sleep(100);
    }
    const state = await (await fetch('http://127.0.0.1:28680/api/recordings')).json();
    expect(state.active).toBeNull(); expect(state.recordings).toHaveLength(1);
    const range = await fetch(`http://127.0.0.1:28680/recordings/${id}-00000.mp4`, { headers: { Range: 'bytes=0-99' } });
    expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch('http://127.0.0.1:28680/api/recordings', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    browser = await chromium.launch({ executablePath: chrome!, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:28680/');
    expect(await page.locator('.scrubber').isVisible()).toBe(false);
    expect(await page.locator('#record').getAttribute('aria-checked')).toBe('false');
    await page.locator('#open-recordings').click();
    await page.locator('.recording-entry').waitFor();
    expect(await page.locator('.recording-entry').innerText()).toContain('GMT');
    await page.locator('.recording-entry').click();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('#timeline')!.disabled);
    expect(await page.locator('.scrubber').isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#timeline').focus();
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    expect(await page.locator('#timeline').getAttribute('aria-valuetext')).toContain('GMT');
    // Native emulated touch through CDP exercises pointer capture and the raised bubble.
    const rect = await page.locator('#timeline').boundingBox(); expect(rect).not.toBeNull();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rect!.x + rect!.width * 0.7, y: rect!.y + rect!.height / 2 }] });
    expect(await page.locator('.scrubber').getAttribute('class')).toContain('touch-scrub');
    const bubble = await page.locator('.seek-preview').boundingBox();
    expect(bubble!.x).toBeGreaterThanOrEqual(0); expect(bubble!.x + bubble!.width).toBeLessThanOrEqual(390);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.screenshot({ path: '/tmp/live-camera-mobile.png' });
    await page.locator('#go-live').click(); expect(await page.locator('.scrubber').isVisible()).toBe(false);
    // Ignore neither script errors nor malformed API responses.
    expect(errors).toEqual([]);
  } finally {
    await browser?.close(); server.kill('SIGTERM'); await server.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);
