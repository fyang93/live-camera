import type { RecordingList } from './types';
const base = `http://127.0.0.1:${process.env.PORT || 8080}`;
try {
  const response = await fetch(`${base}/api/recordings`, { signal: AbortSignal.timeout(5000) });
  // Older player versions have no recording API.
  if (response.ok) {
    const state = await response.json() as RecordingList;
    if (state.active) {
      const stopped = await fetch(`${base}/api/recordings/${state.active}/stop`, { method: 'POST', signal: AbortSignal.timeout(40000) });
      if (!stopped.ok) throw new Error(`Stop failed: ${stopped.status}`);
      await stopped.arrayBuffer();
    }
  }
} catch (error) { console.warn('Recording shutdown:', error); process.exitCode = 1; }
