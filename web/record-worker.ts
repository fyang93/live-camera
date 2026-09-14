// Keep the recorder tied to the player process even if the latter is killed abruptly.
// The parent's stdin pipe closes on death; finalize FFmpeg rather than leaving it recording forever.
import { spawn } from 'node:child_process';
const child = spawn('ffmpeg', process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function stop(): void {
  if (stopping) return; stopping = true;
  child.kill('SIGINT');
  timer = setTimeout(() => child.kill('SIGKILL'), 8000);
}
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { clearTimeout(timer); process.exit(code ?? 1); });
