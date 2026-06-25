import * as fs from 'fs';
import * as path from 'path';
import { realHome } from '../home';

export interface ScannedCodexFile {
  file: string;
  mtimeMs: number;
  size: number;
}

// Codex 세션 로그 위치. ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 만 읽는다.
// realHome() 을 쓴다: 앱 샌드박스(App Store)에선 os.homedir()=$HOME 이 컨테이너를 가리켜
// 비어 보인다. 진짜 홈(/Users/<me>) 접근은 codex 북마크로 따로 허용받는다(main.ts). [[claude-codex-realhome]]
export function codexSessionDirs(): string[] {
  const home = realHome();
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
