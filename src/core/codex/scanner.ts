import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ScannedCodexFile {
  file: string;
  mtimeMs: number;
  size: number;
}

// Codex 세션 로그 위치. 표준은 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// 검증·개발 시 CODEX_SESSIONS_DIR 로 다른 폴더(예: ~/Downloads/05)를 가리킬 수 있다.
export function codexSessionDirs(): string[] {
  const override = process.env.CODEX_SESSIONS_DIR;
  if (override) {
    const p = override.startsWith('~') ? path.join(os.homedir(), override.slice(1)) : override;
    return isDir(p) ? [p] : [];
  }
  const home = os.homedir();
  return [path.join(home, '.codex', 'sessions')].filter(isDir);
}

export function scanCodexJsonl(days: number): ScannedCodexFile[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const out: ScannedCodexFile[] = [];
  for (const root of codexSessionDirs()) walk(root, out, cutoff, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// 날짜 폴더(YYYY/MM/DD)로 5단계까지 내려가며 rollout-*.jsonl 을 모은다
function walk(dir: string, out: ScannedCodexFile[], cutoff: number, depth: number): void {
  if (depth > 5) return;
  for (const name of safeReaddir(dir)) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(p, out, cutoff, depth + 1);
    } else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && st.mtimeMs >= cutoff) {
      out.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
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
