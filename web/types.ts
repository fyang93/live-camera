export type RecordingCodec = 'h264' | 'h265';
export type RecordingStatus = 'starting' | 'recording' | 'stopping' | 'ready' | 'interrupted' | 'failed';
export interface Recording {
  id: string;
  startedAt: number;
  endedAt: number | null;
  duration: number;
  bytes: number;
  codec: RecordingCodec;
  status: RecordingStatus;
  error?: string;
}
export interface RecordingList {
  active: string | null;
  maxSegmentSeconds: number;
  recordings: Recording[];
}
export const isPlayable = (item: Recording): boolean =>
  (item.status === 'ready' || item.status === 'interrupted') && item.duration > 0;
