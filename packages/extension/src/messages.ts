export type JobStatus = 'idle' | 'running' | 'done' | 'error';
export interface JobState { status: JobStatus; tabId?: number; stage?: string; done?: number; total?: number; fileName?: string; size?: number; error?: string; warnings?: string[]; startedAt?: number; finishedAt?: number; hasClipboardCopy?: boolean }
export interface CaptureSettings { revealAnimations: boolean; captureVideoFrames: boolean }
export type ToBackground =
  | { type: 'start'; tabId: number; settings: CaptureSettings }
  | { type: 'fetchAsset'; url: string }
  | { type: 'progress'; stage: string; done: number; total: number }
  | { type: 'complete'; fileName: string; size: number; warnings: string[]; json?: string }
  | { type: 'failed'; error: string }
  | { type: 'getState' }
  | { type: 'reset' };
export type ToContent = { type: 'run'; settings: CaptureSettings };
export const JOB_KEY = 'job'; export const RESULT_KEY = 'resultJson'; export const SETTINGS_KEY = 'settings';
export const CLIPBOARD_LIMIT = 5 * 1024 * 1024;
export const DEFAULT_SETTINGS: CaptureSettings = { revealAnimations: true, captureVideoFrames: true };
