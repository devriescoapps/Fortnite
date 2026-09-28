// File backend for the profile store (Node server): atomic write via temp file + rename.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileBackend } from './profiles';

export function fileBackend(dir: string): ProfileBackend {
  const file = join(dir, 'profiles.json');
  return {
    load: () => (existsSync(file) ? readFileSync(file, 'utf8') : null),
    save: (json) => {
      mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      writeFileSync(tmp, json);
      renameSync(tmp, file);
    },
  };
}
