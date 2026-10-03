export type JobStatus = 'idle' | 'running' | 'done' | 'error';
export interface JobState { status: JobStatus; tabId?: number; stage?: string; done?: number; total?: number; fileName?: string; size?: number; error?: string; warnings?: string[]; startedAt?: number; finishedAt?: number; canCopy?: boolean }
export type ImageQualityName = 'original' | 'balanced' | 'high';
export interface CaptureSettings { revealAnimations: boolean; captureVideoFrames: boolean; imageQuality: ImageQualityName }
export type ToBackground =
  | { type: 'start'; tabId: number; settings: CaptureSettings }
  | { type: 'fetchAsset'; url: string }
  | { type: 'progress'; stage: string; done: number; total: number }
  | { type: 'complete'; fileName: string; size: number; warnings: string[] }
  | { type: 'requestCapture' }
  | { type: 'failed'; error: string }
  | { type: 'getState' }
  | { type: 'reset' };
export type ToContent = { type: 'run'; settings: CaptureSettings } | { type: 'getCapture' };
export const JOB_KEY = 'job'; export const SETTINGS_KEY = 'settings';
/**
 * Sanity ceiling on a single clipboard write. The old 5 MB cap existed because the
 * captured file was parked in chrome.storage.session, which has a hard 10 MB quota; the
 * page now holds its own capture and hands it over on demand, so the only limit left is
 * what one runtime message and one clipboard write can carry.
 */
export const COPY_LIMIT = 60 * 1024 * 1024;
export const DEFAULT_SETTINGS: CaptureSettings = { revealAnimations: true, captureVideoFrames: true, imageQuality: 'balanced' };
