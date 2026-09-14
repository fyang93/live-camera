import { isPlayable, type Recording, type RecordingList } from './types';

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}
const player = element<HTMLElement>('#player');
const video = element<HTMLVideoElement>('#video');
const timeline = element<HTMLInputElement>('#timeline');
const status = element<HTMLElement>('#status');
const selected = element<HTMLElement>('#selected');
const retry = element<HTMLButtonElement>('#retry');
const pauseButton = element<HTMLButtonElement>('#pause');
const recordButton = element<HTMLButtonElement>('#record');
const indicator = element<HTMLElement>('#recording-status');
const listDialog = element<HTMLDialogElement>('#recordings-dialog');
const timeDialog = element<HTMLDialogElement>('#time-dialog');
const seekTime = element<HTMLInputElement>('#seek-time');
const scrubber = element<HTMLElement>('.scrubber');
const preview = element<HTMLElement>('.seek-preview');
let pc: RTCPeerConnection | null = null, session: string | null = null;
let generation = 0, recording: Recording | null = null, dragging = false, gestureNeeded = false;
let snapshot: RecordingList = { active: null, recordings: [], maxSegmentSeconds: 7200 };
let pending = false, polling = false;
let hideTimer: ReturnType<typeof setTimeout>;
let pointer: number | null = null, savedValue = '0';
let releaseTimer: ReturnType<typeof setTimeout>;
const clock = (seconds: number): string => new Date(seconds * 1000).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'shortOffset',
});
const durationLabel = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 3600).toString().padStart(2, '0')}:${Math.floor(total % 3600 / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
};
function reveal(): void {
  player.classList.remove('quiet'); clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!dragging && !video.paused && retry.hidden && !timeDialog.open && !listDialog.open && !scrubber.classList.contains('previewing') && !player.querySelector('.bottom :focus-visible')) player.classList.add('quiet');
  }, 3500);
}
function fail(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
  retry.hidden = false; reveal();
}
function dispose(): number {
  generation++;
  pc?.close(); pc = null;
  if (session) void fetch(session, { method: 'DELETE', keepalive: true }).catch(() => {});
  session = null; gestureNeeded = false;
  video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
  retry.hidden = true;
  return generation;
}
async function play(): Promise<void> {
  try { await video.play(); gestureNeeded = false; retry.hidden = true; }
  catch { gestureNeeded = true; retry.hidden = false; retry.textContent = '点击播放'; reveal(); }
}
async function live(): Promise<void> {
  const id = dispose(); recording = null;
  player.dataset.mode = 'live'; scrubber.hidden = true; timeline.disabled = true;
  element<HTMLButtonElement>('#choose-time').disabled = true;
  selected.textContent = '实时'; status.textContent = '正在连接直播…'; retry.textContent = '重新连接';
  try {
    const peer = pc = new RTCPeerConnection();
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.ontrack = event => {
      if (generation !== id) return;
      video.srcObject = new MediaStream([event.track]); void play(); status.textContent = '';
    };
    peer.onconnectionstatechange = () => {
      if (generation === id && ['failed', 'disconnected'].includes(peer.connectionState)) fail(new Error('直播连接中断，请重连'));
    };
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise<void>((resolve, reject) => {
      if (peer.iceGatheringState === 'complete') { resolve(); return; }
      const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', check); reject(new Error('直播连接超时')); }, 8000);
      function check(): void {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); }
      }
      peer.addEventListener('icegatheringstatechange', check);
    });
    if (id !== generation) return;
    const response = await fetch('/rtc/cam/whep', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: peer.localDescription!.sdp, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`直播连接失败 (${response.status})，请确认推流已启动`);
    const location = response.headers.get('Location');
    if (id !== generation) { if (location) void fetch(location, { method: 'DELETE' }).catch(() => {}); return; }
    session = location; await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) { if (generation === id) fail(error); }
}
function replay(item: Recording): void {
  dispose(); recording = item; player.dataset.mode = 'history';
  status.textContent = '正在加载录像…'; scrubber.hidden = false;
  timeline.min = '0'; timeline.max = String(item.duration); timeline.value = '0'; timeline.disabled = true;
  element<HTMLButtonElement>('#choose-time').disabled = false;
  element<HTMLElement>('#start').textContent = durationLabel(item.duration);
  video.src = `/recordings/${item.id}.mp4`; video.load(); paintTimeline();
  listDialog.close();
}
video.addEventListener('loadedmetadata', () => {
  if (!recording) return;
  if (Number.isFinite(video.duration) && video.duration > 0) timeline.max = String(video.duration);
  timeline.disabled = false; status.textContent = '录像'; void play(); paintTimeline();
});
video.addEventListener('error', () => {
  if (recording) fail(new Error(`录像播放失败 (${video.error?.code || '?'})；${recording.codec === 'h265' ? '请确认浏览器支持 H.265 视频，' : ''}也请检查网络连接`));
});
video.addEventListener('ended', () => { if (recording) { status.textContent = '录像播放结束'; reveal(); } });
retry.onclick = () => { if (gestureNeeded) void play(); else if (recording) replay(recording); else void live(); };
function paintTimeline(): void {
  const max = Number(timeline.max), value = Number(timeline.value);
  timeline.style.setProperty('--progress', `${max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 0}%`);
  selected.textContent = recording ? clock(recording.startedAt / 1000 + value) : '实时';
  timeline.setAttribute('aria-valuetext', recording ? `${selected.textContent}，${durationLabel(value)} / ${durationLabel(max)}` : '实时');
}
video.addEventListener('timeupdate', () => {
  if (!recording || dragging) return;
  timeline.value = String(video.currentTime); paintTimeline();
});
function geometry(): { rect: DOMRect; radius: number; width: number } {
  const rect = timeline.getBoundingClientRect();
  const radius = parseFloat(getComputedStyle(scrubber).getPropertyValue('--thumb-size')) / 2;
  return { rect, radius, width: Math.max(1, rect.width - radius * 2) };
}
function showPreview(value: number): void {
  if (!recording || timeline.disabled) return;
  const max = Number(timeline.max), ratio = Math.max(0, Math.min(1, value / max));
  element<HTMLElement>('#preview-time').textContent = clock(recording.startedAt / 1000 + value);
  element<HTMLElement>('#preview-offset').textContent = `${durationLabel(value)} / ${durationLabel(max)}${pointer !== null ? ' · 松手跳转' : ''}`;
  scrubber.classList.add('previewing');
  const { radius, width } = geometry(); const x = radius + width * ratio;
  scrubber.style.setProperty('--preview-x', `${x}px`);
  preview.style.left = `${Math.max(0, Math.min(scrubber.clientWidth - preview.offsetWidth, x - preview.offsetWidth / 2))}px`;
}
function hidePreview(): void { scrubber.classList.remove('previewing', 'scrubbing', 'touch-scrub'); reveal(); }
function hoverAt(event: PointerEvent): void {
  if (event.pointerType !== 'mouse' || pointer !== null) return;
  const { rect, radius, width } = geometry();
  showPreview(Math.max(0, Math.min(1, (event.clientX - rect.left - radius) / width)) * Number(timeline.max));
}
timeline.addEventListener('pointerenter', hoverAt); timeline.addEventListener('pointermove', hoverAt);
timeline.addEventListener('pointerleave', () => { if (pointer === null) hidePreview(); });
timeline.addEventListener('pointerdown', event => {
  if (timeline.disabled || !event.isPrimary || event.button !== 0) return;
  clearTimeout(releaseTimer); pointer = event.pointerId; savedValue = timeline.value; dragging = true;
  timeline.setPointerCapture(pointer); scrubber.classList.add('scrubbing');
  scrubber.classList.toggle('touch-scrub', event.pointerType !== 'mouse'); showPreview(Number(timeline.value));
});
timeline.addEventListener('input', () => { dragging = true; paintTimeline(); showPreview(Number(timeline.value)); });
timeline.addEventListener('change', () => {
  if (recording) video.currentTime = Number(timeline.value);
  dragging = false; paintTimeline(); reveal();
});
function finishScrub(cancelled = false): void {
  if (pointer === null) return;
  if (cancelled) { timeline.value = savedValue; paintTimeline(); }
  pointer = null; dragging = false; hidePreview();
}
timeline.addEventListener('pointerup', () => { releaseTimer = setTimeout(() => finishScrub(), 0); });
timeline.addEventListener('pointercancel', () => finishScrub(true));
timeline.addEventListener('lostpointercapture', () => { clearTimeout(releaseTimer); releaseTimer = setTimeout(() => finishScrub(), 0); });
timeline.addEventListener('focus', () => { if (timeline.matches(':focus-visible')) showPreview(Number(timeline.value)); });
timeline.addEventListener('blur', () => { if (pointer === null) hidePreview(); });
window.addEventListener('blur', () => { finishScrub(true); hidePreview(); });
window.addEventListener('resize', () => { if (scrubber.classList.contains('previewing')) showPreview(Number(timeline.value)); });
function syncPause(): void {
  pauseButton.setAttribute('aria-label', video.paused ? '播放' : '暂停');
  element<SVGPathElement>('#pause-symbol').setAttribute('d', video.paused ? 'M8 5l11 7-11 7Z' : 'M8 5v14M16 5v14');
}
video.addEventListener('play', syncPause); video.addEventListener('pause', syncPause);
pauseButton.onclick = () => { if (video.paused) { if (!recording) void live(); else void play(); } else video.pause(); reveal(); };
element<HTMLButtonElement>('#go-live').onclick = () => { void live(); reveal(); };
const fullscreenButton = element<HTMLButtonElement>('#fullscreen');
type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
if (!player.requestFullscreen && !(video as FullscreenVideo).webkitEnterFullscreen) fullscreenButton.hidden = true;
fullscreenButton.onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (player.requestFullscreen) await player.requestFullscreen();
    else (video as FullscreenVideo).webkitEnterFullscreen?.();
  } catch { status.textContent = '当前浏览器无法进入全屏'; }
  reveal();
};
document.addEventListener('fullscreenchange', () => { fullscreenButton.setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '全屏'); reveal(); });
function localInput(seconds: number): string {
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
element<HTMLButtonElement>('#choose-time').onclick = () => {
  if (!recording || timeline.disabled) return;
  const start = recording.startedAt / 1000, end = start + Number(timeline.max);
  seekTime.min = localInput(Math.ceil(start)); seekTime.max = localInput(Math.floor(end));
  seekTime.value = localInput(Math.max(Math.ceil(start), Math.min(Math.floor(end), Math.floor(start + video.currentTime))));
  element<HTMLElement>('#available').textContent = `${clock(start)} — ${clock(end)}`;
  element<HTMLElement>('#seek-error').textContent = ''; timeDialog.showModal();
};
element<HTMLButtonElement>('#cancel-time').onclick = () => timeDialog.close();
element<HTMLFormElement>('#time-form').onsubmit = event => {
  event.preventDefault(); if (!recording) return;
  const offset = new Date(seekTime.value).getTime() / 1000 - recording.startedAt / 1000;
  if (!Number.isFinite(offset) || offset < 0 || offset > Number(timeline.max)) { element<HTMLElement>('#seek-error').textContent = '时间不在本段录像范围内'; return; }
  video.currentTime = offset; timeline.value = String(offset); paintTimeline(); timeDialog.close(); reveal();
};
async function api(path = '/api/recordings', method = 'GET'): Promise<RecordingList> {
  const response = await fetch(path, { method, cache: 'no-store', signal: AbortSignal.timeout(30000) });
  const data = await response.json() as RecordingList & { error?: string };
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
function renderRecordings(): void {
  recordButton.setAttribute('aria-checked', String(!!snapshot.active));
  recordButton.title = snapshot.active ? '停止录像并保存' : '开始录像';
  recordButton.setAttribute('aria-label', recordButton.title); recordButton.disabled = pending;
  indicator.hidden = !snapshot.active;
  const current = snapshot.recordings.find(item => item.id.startsWith(`${snapshot.active}-`) && ['starting', 'recording', 'stopping'].includes(item.status));
  indicator.textContent = current?.status === 'starting' ? '● 准备录像' : current?.status === 'stopping' ? '● 正在保存' : '● REC';
  const on = !!snapshot.active;
  element<HTMLElement>('#recordings-note').textContent = `${on ? '正在录像，开关对所有设备生效。' : '录像已关闭，不写入视频。'}每段最长 ${snapshot.maxSegmentSeconds / 3600} 小时，自动接续。`;
  if (!listDialog.open) return;
  const list = element<HTMLElement>('#recordings-list'); list.replaceChildren();
  if (!snapshot.recordings.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有录像。点击底部圆点开始录制。'; list.append(empty); return; }
  for (const item of snapshot.recordings) {
    const row = document.createElement('li'); row.className = 'recording-row';
    const button = document.createElement('button'); button.className = 'recording-entry'; button.disabled = !isPlayable(item);
    const title = document.createElement('strong'); title.textContent = clock(item.startedAt / 1000);
    const detail = document.createElement('span');
    const labels = { starting: '准备中', recording: '正在录制', stopping: '正在保存', ready: '可回放', interrupted: '中断后恢复', failed: '失败' };
    detail.textContent = `${durationLabel(item.duration)} · ${(item.bytes / 1024 ** 2).toFixed(1)} MB · ${labels[item.status]}`;
    button.append(title, detail); button.onclick = () => replay(item); row.append(button);
    if (item.error) { const error = document.createElement('small'); error.className = 'recording-error'; error.textContent = item.error; row.append(error); }
    const remove = document.createElement('button'); remove.className = 'delete-recording'; remove.textContent = '删除';
    remove.disabled = pending || item.id.startsWith(`${snapshot.active}-`);
    remove.setAttribute('aria-label', `删除 ${clock(item.startedAt / 1000)} 的录像`);
    remove.onclick = async () => {
      if (!confirm('永久删除这段录像？')) return;
      pending = true; renderRecordings();
      try { snapshot = await api(`/api/recordings/${item.id}`, 'DELETE'); if (recording?.id === item.id) void live(); }
      catch (error) { listError(error); }
      finally { pending = false; renderRecordings(); }
    };
    row.append(remove); list.append(row);
  }
}
function listError(error: unknown): void {
  element<HTMLElement>('#recordings-error').textContent = error instanceof Error ? error.message : String(error);
}
async function pollRecordings(): Promise<void> {
  if (polling || pending) return; polling = true;
  try {
    const result = await api();
    if (!pending) {
      if (snapshot.active && !result.active && result.recordings.some(item => item.id.startsWith(`${snapshot.active}-`) && item.error)) {
        status.textContent = '录像已停止，请查看录像列表'; reveal();
      }
      snapshot = result; renderRecordings();
    }
  }
  catch (error) { listError(error); }
  finally { polling = false; }
}
recordButton.onclick = async () => {
  if (pending) return;
  pending = true; renderRecordings();
  element<HTMLElement>('#recordings-error').textContent = '';
  try { snapshot = await api(snapshot.active ? `/api/recordings/${snapshot.active}/stop` : '/api/recordings', 'POST'); }
  catch (error) { listError(error); if (!listDialog.open) listDialog.showModal(); }
  finally { pending = false; renderRecordings(); reveal(); }
};
element<HTMLButtonElement>('#open-recordings').onclick = () => { listDialog.showModal(); renderRecordings(); void pollRecordings(); };
element<HTMLButtonElement>('#close-recordings').onclick = () => listDialog.close();
for (const dialog of [timeDialog, listDialog]) dialog.addEventListener('close', reveal);
for (const event of ['pointermove', 'pointerdown', 'focusin', 'keydown']) player.addEventListener(event, reveal);
video.addEventListener('click', reveal); video.addEventListener('playing', reveal); video.addEventListener('pause', reveal);
window.addEventListener('pagehide', () => { dispose(); }); // Recording belongs to the server, not this tab.
window.addEventListener('pageshow', event => { if (event.persisted) void live(); });
void live(); void pollRecordings(); setInterval(() => { void pollRecordings(); }, 3000);
syncPause(); reveal();
