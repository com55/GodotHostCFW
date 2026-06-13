// MIME types for Godot web export files. Mirrors the original Node server.
const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  wasm: 'application/wasm',
  pck: 'application/octet-stream',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webp: 'image/webp',
};

export function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
