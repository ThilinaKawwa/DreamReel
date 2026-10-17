// Where the soundtrack library and brand fonts live on the server.
// Add a track: drop <mood>.m4a into assets/music and add the mood to MOODS in narration.js.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { MOODS } from './narration.js';

const ROOT = path.join(process.cwd(), 'assets');

export const FONTS_DIR = path.join(ROOT, 'fonts');

/** @returns {{id: string, file: string}|null} */
export function soundtrackFor(mood) {
  const id = MOODS.includes(mood) ? mood : 'dreamy';
  const file = path.join(ROOT, 'music', `${id}.m4a`);
  return existsSync(file) ? { id, file } : null;
}
