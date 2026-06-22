import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAnalysis } from '../core/analyze';
import { runCodexAnalysis } from '../core/codex/analyze';
import { runCoaching } from '../core/llm';
import { Report, SnapshotMeta, RankResult, RankView, LeaderboardView, LeaderboardRow, LeaderboardRowView } from '../core/types';
import { submitAndRank, getRank, leaderboard as fetchLeaderboard, setName as remoteSetName } from '../core/remote';
import { standingFor } from '../core/tier';
import { randomUUID } from 'crypto';

let win: BrowserWindow | null = null;
let lastReport: Report | null = null;

function createWindow(): void {
  // 시작 시 화면 가용 영역의 최대 높이로 띄운다 (폭은 문서 가독 폭 유지, 가로 중앙 정렬)
  const { workArea } = screen.getPrimaryDisplay();
  const winWidth = Math.min(1100, workArea.width);
  win = new BrowserWindow({
    width: winWidth,
    height: workArea.height,
    x: workArea.x + Math.max(0, Math.round((workArea.width - winWidth) / 2)),
    y: workArea.y,
    minWidth: 880,
    minHeight: 640,
    title: 'AI 리포트',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    },
  });
  // 근거 출처 링크(외부 http/https)는 앱 안에서 열지 않고 기본 브라우저로 넘긴다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
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
  migrateUserData();
  createWindow();
});

// 앱 이름(productName)이 바뀌면 userData 폴더 경로도 같이 바뀐다.
// "AI Usage Checkup" → "AI 분석 리포트" → "AI 리포트" 로 두 번 개명했다.
// 새 폴더에 없는 항목만 옛 폴더에서 한 번 복사해, install_id(랭킹 신원)·스냅샷(추이)·닉네임을
// 끊김 없이 잇는다. install_id 를 이어받아야 개명 때마다 서버에 "고스트 행"이 새로 생기지 않는다.
function migrateUserData(): void {
  const appData = app.getPath('appData');
  const newDir = app.getPath('userData');
  const oldDirs = ['AI 분석 리포트', 'AI Usage Checkup'].map((n) => path.join(appData, n));

  // 단일 파일(install_id·nickname): 새 폴더에 없으면 옛 폴더에서 처음 발견된 걸 복사
  const copyFileIfMissing = (rel: string): void => {
    const dest = path.join(newDir, rel);
    if (fs.existsSync(dest)) return;
    for (const d of oldDirs) {
      const src = path.join(d, rel);
      if (fs.existsSync(src)) {
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        } catch {
          // 마이그레이션 실패는 치명적이지 않다
        }
        return;
      }
    }
  };

  try {
    copyFileIfMissing('install_id');
    copyFileIfMissing('nickname');

    // 스냅샷 폴더: 새 폴더가 비어 있을 때만 옛 폴더 전체를 복사한다
    const newSnaps = snapshotsDir();
    const dateJson = /^\d{4}-\d{2}-\d{2}\.json$/;
    const hasNew = fs.existsSync(newSnaps) && fs.readdirSync(newSnaps).some((f) => dateJson.test(f));
    if (!hasNew) {
      for (const d of oldDirs) {
        const oldSnaps = path.join(d, 'snapshots');
        if (fs.existsSync(oldSnaps) && fs.readdirSync(oldSnaps).some((f) => dateJson.test(f))) {
          fs.mkdirSync(newSnaps, { recursive: true });
          for (const f of fs.readdirSync(oldSnaps)) {
            if (dateJson.test(f)) fs.copyFileSync(path.join(oldSnaps, f), path.join(newSnaps, f));
          }
          break;
        }
      }
    }
  } catch {
    // 마이그레이션 실패는 치명적이지 않다 (스냅샷은 다시 쌓이고 install_id 는 새로 발급된다)
  }
}

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('analyze', async (_e, days: number) => {
  // App Store(MAS) 빌드: 컨테이너 밖(~/.claude) 읽기는 사용자가 허용한 폴더의
  // security-scoped 북마크로만 가능하다. 북마크가 없으면 폴더 허용을 먼저 요청한다.
  let stop: (() => void) | null = null;
  if (process.mas) {
    const bm = readBookmark();
    if (!bm) return { status: 'need_access' };
    try {
      stop = app.startAccessingSecurityScopedResource(bm) as () => void;
    } catch {
      return { status: 'need_access' };
    }
  }
  try {
    const report = await runAnalysis(days || 30, (p) => {
      win?.webContents.send('progress', p);
    });
    lastReport = report;
    // 전체 순위 참여에 동의한 경우에만 점수(숫자)를 서버에 올리고 순위를 받는다.
    // 동의 전이면 업로드하지 않으며, 리포트는 절대평가 Lv. 로 표시된다(renderLevel 폴백).
    const rank = readRankConsent() === 'yes' ? await pushScore(report) : null;
    if (rank) report.rank = rank;
    saveSnapshot(report, 'claude');
    return report;
  } finally {
    if (stop) stop();
  }
});

ipcMain.handle('analyzeCodex', async (_e, days: number) => {
  // Codex 분석은 ~/.codex/sessions 를 읽는다. 랭킹·코칭은 범위 밖(클로드 점수 기준)이지만,
  // 스냅샷은 남겨 이전 결과·점수 추이에서 클로드와 나란히 비교한다.
  const report = await runCodexAnalysis(days || 30, (p) => {
    win?.webContents.send('progress', p);
  });
  saveSnapshot(report, 'codex');
  return report;
});

ipcMain.handle('coach', async () => {
  // App Store(MAS) 빌드에서는 외부 claude CLI 실행이 불가해 코칭을 제공하지 않는다
  if (process.mas) return { status: 'error', message: '코칭은 직접 배포판에서만 제공돼요.' };
  if (!lastReport) return { status: 'error', message: '먼저 분석을 실행해주세요.' };
  return runCoaching(lastReport, 'opus');
});

ipcMain.handle('copy', (_e, text: string) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.handle('saveReportPdf', async (_e, suggestedName: string, layout?: { width: number; height: number }) => {
  if (!win) return { ok: false, error: '열려 있는 리포트 창을 찾지 못했어요.' };

  const safeName = sanitizePdfFilename(suggestedName);
  const pageSize = pdfPageSize(layout);
  const res = await dialog.showSaveDialog(win, {
    title: 'PDF 저장',
    defaultPath: path.join(app.getPath('documents'), safeName),
    buttonLabel: '저장',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };

  try {
    const pdf = await win.webContents.printToPDF({
      pageSize,
      margins: { marginType: 'none' },
      printBackground: true,
      preferCSSPageSize: false,
      generateDocumentOutline: true,
    });
    fs.writeFileSync(res.filePath, pdf);
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('history', () => listSnapshots());

ipcMain.handle('snapshot', (_e, date: string, source?: 'claude' | 'codex') => loadSnapshot(date, source ?? 'claude'));

// 점수 재전송 없이 순위만 갱신 (현재 분석 결과 기준). 동의 전에는 점수를 서버로 보내지 않는다.
ipcMain.handle('rank', async () => {
  if (!lastReport || readRankConsent() !== 'yes') return null;
  try {
    return toView(await getRank(reportAvg(lastReport)));
  } catch {
    return null;
  }
});

// 홈 시작화면용: 가장 최근 저장본의 점수로 최신 순위를 바로 조회.
// 랭킹은 클로드 점수 기준이라 코덱스 스냅샷은 제외한다. 동의 전에는 조회하지 않는다.
ipcMain.handle('latestRank', async () => {
  if (readRankConsent() !== 'yes') return null;
  const snap = listSnapshots().find((s) => s.source === 'claude');
  if (!snap) return null;
  try {
    return toView(await getRank(snap.avgScore));
  } catch {
    return null;
  }
});

// 랭킹 리더보드: 상위 5위 + 내 행. 행마다 티어(엠블럼)까지 계산해 내려보낸다.
ipcMain.handle('leaderboard', () => leaderboardView());

// 닉네임(공개 랭킹 표시명): 로컬 userData 에 저장. 파일 유무로 "이미 정했는지"를 구분한다.
ipcMain.handle('getNickname', () => readNickname());
ipcMain.handle('setNickname', (_e, name: string) => writeNickname(name));

// 전체 순위 업로드 동의: 조회 / 설정. 'yes' 가 되기 전에는 점수·닉네임이 서버로 나가지 않는다.
ipcMain.handle('getRankConsent', () => readRankConsent());
ipcMain.handle('setRankConsent', (_e, agree: boolean) => writeRankConsent(!!agree));

// 방금 동의한 사용자가 곧바로 순위에 반영되도록, 직전 분석 결과를 한 번 올려 순위를 돌려준다.
// (동의 흐름에서만 호출. 동의 전이거나 분석 결과가 없으면 null)
ipcMain.handle('submitCurrent', async () => {
  if (readRankConsent() !== 'yes' || !lastReport) return null;
  return pushScore(lastReport);
});

// App Store(MAS) 폴더 접근: ~/.claude 를 한 번 선택받아 북마크로 저장한다.
// defaultPath 를 .claude 로 줘서 숨김 폴더여도 그 안에서 창이 열린다.
ipcMain.handle('chooseClaudeDir', async () => {
  const opts: Electron.OpenDialogOptions = {
    defaultPath: path.join(os.homedir(), '.claude'),
    properties: ['openDirectory'],
    securityScopedBookmarks: true,
    buttonLabel: '이 폴더 허용',
    message: 'AI 리포트가 사용 기록을 읽을 ~/.claude 폴더를 허용해주세요',
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths.length) return { ok: false };
  if (res.bookmarks && res.bookmarks[0]) writeBookmark(res.bookmarks[0]);
  return { ok: true, path: res.filePaths[0] };
});

// 렌더러 온보딩 분기용: MAS 빌드인지 + 폴더 접근 북마크 보유 여부
ipcMain.handle('claudeAccess', () => ({ isMas: process.mas === true, hasAccess: !!readBookmark() }));

// ── App Store(MAS) 폴더 접근: security-scoped bookmark ──────────────
// 샌드박스에서 ~/.claude 를 읽으려면 사용자가 고른 폴더의 북마크가 필요하다.
// 닉네임·install_id 와 같은 방식으로 userData 에 base64 문자열로 저장한다.
function bookmarkPath(): string {
  return path.join(app.getPath('userData'), 'claude-bookmark');
}
function readBookmark(): string | null {
  try {
    const b = fs.readFileSync(bookmarkPath(), 'utf8').trim();
    return b || null;
  } catch {
    return null;
  }
}
function writeBookmark(b: string): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(bookmarkPath(), b);
  } catch {
    // 저장 실패해도 다음 실행 때 다시 허용을 요청하면 된다
  }
}

function sanitizePdfFilename(name: string): string {
  const base = String(name || '')
    .normalize('NFC')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  const fallback = 'AI 리포트.pdf';
  if (!base) return fallback;
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

function pdfPageSize(layout?: { width: number; height: number }): Electron.PrintToPDFOptions['pageSize'] {
  const width = Math.ceil(Number(layout?.width));
  const height = Math.ceil(Number(layout?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'A4';

  // Chromium PDF pageSize uses inches. The renderer sends CSS pixels at 96dpi.
  return {
    width: Math.min(Math.max(width, 640), 2400) / 96,
    height: Math.min(Math.max(height, 900), 3400) / 96,
  };
}

// ── 익명 랭킹: 설치 ID · 닉네임 · 전송 ──────────────────────────────
// 첫 실행 때 한 번 만든 랜덤 UUID. 로그인 대신 "이 설치"를 식별한다 (개인정보 아님)
function installId(): string {
  const p = path.join(app.getPath('userData'), 'install_id');
  try {
    const cur = fs.readFileSync(p, 'utf8').trim();
    if (cur) return cur;
  } catch {
    // 없으면 새로 만든다
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, id);
  } catch {
    // 저장 실패해도 이번 세션 id는 반환
  }
  return id;
}

// 닉네임은 userData/nickname 파일에 저장한다(install_id 와 같은 방식). 파일이 없으면 "아직 안 정함".
function nicknamePath(): string {
  return path.join(app.getPath('userData'), 'nickname');
}
function readNickname(): { name: string; chosen: boolean } {
  try {
    return { name: fs.readFileSync(nicknamePath(), 'utf8').trim(), chosen: true };
  } catch {
    return { name: '', chosen: false };
  }
}
function writeNickname(name: string): string {
  const clean = String(name ?? '').trim().slice(0, 24);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(nicknamePath(), clean);
  } catch {
    // 저장 실패해도 이번 세션 값은 반환
  }
  // 닉네임은 "전체 순위 참여에 동의"한 경우에만 서버로 보낸다. 동의 전에는 로컬에만 저장한다.
  // (이미 분석해 서버에 행이 있으면 닉네임을 즉시 반영한다. 행이 없으면 set_name 은 no-op)
  if (readRankConsent() === 'yes') remoteSetName(installId(), clean).catch(() => {});
  return clean;
}

// ── 전체 순위(리더보드) 업로드 동의 ───────────────────────────────
// App Store 가이드라인 5.1.2(i): 점수를 서버(전체 순위)에 올리기 전에 사용자의 명시적 동의를 받아야 한다.
// 동의 여부는 userData/rank-consent 파일에 'yes'/'no' 로 저장한다. 파일이 없으면 'unset'(아직 안 물어봄).
// 'yes' 가 아니면 어떤 점수·닉네임도 서버로 나가지 않는다(분석은 로컬에서 그대로 동작).
function rankConsentPath(): string {
  return path.join(app.getPath('userData'), 'rank-consent');
}
function readRankConsent(): 'yes' | 'no' | 'unset' {
  try {
    const v = fs.readFileSync(rankConsentPath(), 'utf8').trim();
    return v === 'yes' ? 'yes' : v === 'no' ? 'no' : 'unset';
  } catch {
    return 'unset';
  }
}
function writeRankConsent(agree: boolean): 'yes' | 'no' {
  const v: 'yes' | 'no' = agree ? 'yes' : 'no';
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(rankConsentPath(), v);
  } catch {
    // 저장 실패해도 이번 세션 값은 반환
  }
  return v;
}

// 리포트 점수 → 서버로 보낼 숫자들. 축별 점수 + 평균, 이게 전부다
function reportAvg(r: Report): number {
  const s = r.scores || [];
  return s.length ? Math.round(s.reduce((a, x) => a + x.score, 0) / s.length) : 0;
}
function reportAxes(r: Report): Record<string, number> {
  const o: Record<string, number> = {};
  for (const s of r.scores || []) o[s.axis] = Math.round(s.score);
  return o;
}
// 서버 응답(숫자) → 티어/상위%까지 계산한 뷰. 표본 수와 무관하게 percentile 만 있으면 티어를 매긴다.
function toView(r: RankResult): RankView {
  const v: RankView = { ...r };
  if (r.percentile != null) {
    const s = standingFor(r.percentile);
    v.tier = { key: s.tier.key, name: s.tier.name, color: s.tier.color };
    v.topPct = s.topPct;
  }
  return v;
}

async function pushScore(r: Report): Promise<RankView | null> {
  try {
    return toView(
      await submitAndRank(installId(), reportAvg(r), reportAxes(r), app.getVersion(), readNickname().name),
    );
  } catch (e) {
    console.error('[rank] submit failed', e);
    return null;
  }
}

// 리더보드: 서버가 준 행별 percentile → 티어(엠블럼 키)를 채워 renderer 에 내려보낸다.
function rowWithTier(r: LeaderboardRow): LeaderboardRowView {
  if (r.percentile == null) return { ...r };
  const s = standingFor(r.percentile);
  return { ...r, tier: { key: s.tier.key, name: s.tier.name, color: s.tier.color } };
}
async function leaderboardView(): Promise<LeaderboardView | null> {
  try {
    // 동의 전에는 내 install_id 를 서버로 보내지 않는다(상위 5위 공개 데이터만 읽고, '내 행' 식별은 안 함).
    const id = readRankConsent() === 'yes' ? installId() : null;
    const lb = await fetchLeaderboard(id, 5);
    return {
      total: lb.total,
      top: (lb.top ?? []).map(rowWithTier),
      me: lb.me ? rowWithTier(lb.me) : null,
    };
  } catch (e) {
    console.error('[leaderboard] failed', e);
    return null;
  }
}

function snapshotsDir(): string {
  return path.join(app.getPath('userData'), 'snapshots');
}

// 30일이 지나면 원본 jsonl이 지워지므로, 분석 시점의 집계를 남겨 추이를 보존한다.
// 클로드는 기존대로 `YYYY-MM-DD.json`, 코덱스는 `YYYY-MM-DD.codex.json`로 분리 저장해
// 같은 날 둘 다 분석해도 덮어쓰지 않고 나란히 보존한다(기존 클로드 저장본·정규식 호환).
function snapshotFile(date: string, source: 'claude' | 'codex'): string {
  return path.join(snapshotsDir(), source === 'codex' ? `${date}.codex.json` : `${date}.json`);
}

function saveSnapshot(report: Report, source: 'claude' | 'codex'): void {
  try {
    fs.mkdirSync(snapshotsDir(), { recursive: true });
    const { samples, ...slim } = report;
    fs.writeFileSync(snapshotFile(report.generatedAt.slice(0, 10), source), JSON.stringify(slim, null, 2));
  } catch {
    // 스냅샷 실패는 치명적이지 않다
  }
}

function listSnapshots(): SnapshotMeta[] {
  try {
    return fs
      .readdirSync(snapshotsDir())
      .flatMap((f): { date: string; source: 'claude' | 'codex' }[] => {
        const codex = /^(\d{4}-\d{2}-\d{2})\.codex\.json$/.exec(f);
        if (codex) return [{ date: codex[1], source: 'codex' }];
        const claude = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
        if (claude) return [{ date: claude[1], source: 'claude' }];
        return [];
      })
      // 최신순. 같은 날이면 클로드를 먼저(랭킹 등 기본 도구가 클로드라 우선 노출)
      .sort((a, b) => (a.date === b.date ? (a.source === b.source ? 0 : a.source === 'claude' ? -1 : 1) : a.date < b.date ? 1 : -1))
      .slice(0, 60)
      .flatMap(({ date, source }) => {
        try {
          const r = JSON.parse(fs.readFileSync(snapshotFile(date, source), 'utf8'));
          const scores: { score: number }[] = Array.isArray(r.scores) ? r.scores : [];
          const avg = scores.length ? scores.reduce((a, s) => a + s.score, 0) / scores.length : 0;
          return [
            {
              date,
              source,
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

function loadSnapshot(date: string, source: 'claude' | 'codex'): Report | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotFile(date, source), 'utf8'));
  } catch {
    return null;
  }
}
