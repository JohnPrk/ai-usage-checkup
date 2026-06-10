import * as fs from 'fs';
import * as path from 'path';
import { claudeProjectDirs } from './paths';

export interface ScannedFile {
  file: string;
  projectDir: string;
  isSubagentFile: boolean;
  mtimeMs: number;
  size: number;
}

export function scanJsonl(days: number): ScannedFile[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const out: ScannedFile[] = [];
  for (const root of claudeProjectDirs()) {
    for (const proj of safeReaddir(root)) {
      const projPath = path.join(root, proj);
      if (!isDir(projPath)) continue;
      walk(projPath, proj, out, cutoff, 0);
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function walk(dir: string, projectDir: string, out: ScannedFile[], cutoff: number, depth: number): void {
  if (depth > 4) return;
  for (const name of safeReaddir(dir)) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(p, projectDir, out, cutoff, depth + 1);
    } else if (name.endsWith('.jsonl') && st.mtimeMs >= cutoff) {
      out.push({
        file: p,
        projectDir,
        isSubagentFile: p.includes(`${path.sep}subagents${path.sep}`),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
