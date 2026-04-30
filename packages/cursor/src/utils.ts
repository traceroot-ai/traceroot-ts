import { ERROR_MESSAGE_PREVIEW_MAX, TOOL_RESULT_PREVIEW_MAX } from './types.js';

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

export function jsonPreview(value: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? '';
  } catch {
    s = '[unserializable]';
  }
  return truncate(s, max);
}

export function jsonSize(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

export function errorPreview(message: string): string {
  return truncate(message, ERROR_MESSAGE_PREVIEW_MAX);
}

export function toolResultPreview(value: unknown): string {
  return jsonPreview(value, TOOL_RESULT_PREVIEW_MAX);
}
