import * as path from 'path';
import * as fs from 'fs';
import { realHome } from './home';

export function claudeProjectDirs(): string[] {
  const home = realHome();
  const candidates = [
    path.join(home, '.claude', 'projects'),
    path.join(home, '.config', 'claude', 'projects'),
  ];
  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}
