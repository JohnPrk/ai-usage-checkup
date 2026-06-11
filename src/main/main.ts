import { app, BrowserWindow, clipboard, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { runAnalysis } from '../core/analyze';
import { runCoaching } from '../core/llm';
import { Report, SnapshotMeta } from '../core/types';

let win: BrowserWindow | null = null;
let lastReport: Report | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 880,
    minHeight: 640,
    title: 'AI 성적표',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    },
  });
  // 렌더러 콘솔 에러는 메인 로그에 안 보이므로 stdout으로 흘려보낸다
  win.webContents.on('console-message', (ev) => {
    if (ev.level === 'error' || ev.level === 'warning') {
      console.error(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`);
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  migrateSnapshots();
  createWindow();
});

// 앱 이름이 'AI Usage Checkup' → 'AI 성적표'로 바뀌면서 userData 폴더도 바뀐다.
// 옛 폴더에만 스냅샷이 있으면 새 폴더로 한 번 복사해 추이를 잇는다.
function migrateSnapshots(): void {
  try {
    const newDir = snapshotsDir();
    if (fs.existsSync(newDir) && fs.readdirSync(newDir).length > 0) return;
    const oldDir = path.join(app.getPath('appData'), 'AI Usage Checkup', 'snapshots');
    if (!fs.existsSync(oldDir)) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of fs.readdirSync(oldDir)) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) {
        fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f));
      }
    }
  } catch {
    // 마이그레이션 실패는 치명적이지 않다 (스냅샷은 다시 쌓인다)
  }
}

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('analyze', async (_e, days: number) => {
  const report = await runAnalysis(days || 30, (p) => {
    win?.webContents.send('progress', p);
  });
  lastReport = report;
  saveSnapshot(report);
  return report;
});

ipcMain.handle('coach', async () => {
  if (!lastReport) return { status: 'error', message: '먼저 분석을 실행해주세요.' };
  return runCoaching(lastReport, 'opus');
});

ipcMain.handle('copy', (_e, text: string) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.handle('history', () => listSnapshots());

ipcMain.handle('snapshot', (_e, date: string) => loadSnapshot(date));

function snapshotsDir(): string {
  return path.join(app.getPath('userData'), 'snapshots');
}

// 30일이 지나면 원본 jsonl이 지워지므로, 분석 시점의 집계를 남겨 추이를 보존한다
function saveSnapshot(report: Report): void {
  try {
    const dir = snapshotsDir();
    fs.mkdirSync(dir, { recursive: true });
    const { samples, ...slim } = report;
    fs.writeFileSync(path.join(dir, report.generatedAt.slice(0, 10) + '.json'), JSON.stringify(slim, null, 2));
  } catch {
    // 스냅샷 실패는 치명적이지 않다
  }
}

function listSnapshots(): SnapshotMeta[] {
  try {
    return fs
      .readdirSync(snapshotsDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse()
      .slice(0, 40)
      .flatMap((f) => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(snapshotsDir(), f), 'utf8'));
          const scores: { score: number }[] = Array.isArray(r.scores) ? r.scores : [];
          const avg = scores.length ? scores.reduce((a, s) => a + s.score, 0) / scores.length : 0;
          return [
            {
              date: f.slice(0, 10),
              sessions: typeof r.sessions === 'number' ? r.sessions : 0,
              totalTokens: typeof r.totals?.all === 'number' ? r.totals.all : 0,
              avgScore: Math.round(avg),
            },
          ];
        } catch {
          return []; // 깨진 스냅샷은 목록에서 뺀다
        }
      });
  } catch {
    return [];
  }
}

function loadSnapshot(date: string): Report | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(snapshotsDir(), date + '.json'), 'utf8'));
  } catch {
    return null;
  }
}
