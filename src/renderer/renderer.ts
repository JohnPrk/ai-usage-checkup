// DOM lib에 동명의 Report 인터페이스가 있어 UsageReport로 구분한다
type UsageReport = Awaited<ReturnType<typeof window.api.analyze>>;
type Coaching = Awaited<ReturnType<typeof window.api.coach>>;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing element: ' + id);
  return el;
};

let running = false;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTokens(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '억';
  if (n >= 1e4) return Math.round(n / 1e4).toLocaleString() + '만';
  return n.toLocaleString();
}

function fmtUSD(n: number): string {
  return '$' + (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1));
}

window.api.onProgress((p) => {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  ($('bar-fill') as HTMLElement).style.width = pct + '%';
  $('progress-label').textContent = `${p.phase} (${p.done}/${p.total})`;
});

async function analyze(): Promise<void> {
  if (running) return;
  running = true;
  const btn = $('btn-analyze') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = '분석 중…';
  $('report').classList.add('hidden');
  $('onboarding').classList.add('hidden');
  $('progress').classList.remove('hidden');
  $('subtitle').textContent = '최근 30일 기록을 읽는 중…';
  try {
    const report = await window.api.analyze(30);
    $('progress').classList.add('hidden');
    ($('history-select') as HTMLSelectElement).value = '';
    render(report);
    void loadHistory(); // 방금 저장된 스냅샷이 목록에 보이게
  } catch (e) {
    // 진행 영역을 그대로 두고 에러를 보여준다. 여기서 숨기면 실패가 무반응처럼 보인다
    ($('bar-fill') as HTMLElement).style.width = '0%';
    $('progress-label').textContent = '분석 실패: ' + String(e);
    $('subtitle').textContent = '분석에 실패했어요';
  } finally {
    running = false;
    btn.disabled = false;
    btn.textContent = '다시 분석';
  }
}

function render(r: UsageReport, snapshotDate?: string): void {
  if (r.sessions === 0) {
    renderOnboarding(r);
    return;
  }
  $('onboarding').classList.add('hidden');
  $('subtitle').textContent = snapshotDate
    ? `${snapshotDate} 저장본 · 세션 ${r.sessions.toLocaleString()}개`
    : `분석일 ${r.generatedAt.slice(0, 10)} · 최근 ${r.days}일 · 세션 ${r.sessions.toLocaleString()}개`;

  renderLevel(r);
  renderAxes(r);
  renderMetrics(r);
  renderCategories(r);
  renderActivities(r);
  renderInventory(r);
  renderRecs($('recs'), r.recommendations, false);

  const coachBtn = $('btn-coach') as HTMLButtonElement;
  if (snapshotDate) {
    // 코칭은 방금 분석한 리포트(메인 프로세스 메모리)를 쓰므로 저장본에서는 막는다
    coachBtn.disabled = true;
    $('coach-body').innerHTML =
      '<p class="hint">저장본에서는 코칭을 새로 부를 수 없어요. 다시 분석한 뒤 이용해주세요.</p>';
  } else {
    coachBtn.disabled = false;
    $('coach-body').innerHTML = '';
  }

  $('meta').textContent =
    `파일 ${r.files}개 · 건너뛴 라인 ${r.skippedLines.toLocaleString()}개 · ` +
    `예상 사용 비용 ${fmtUSD(r.estCostUSD)} (API 환산 참고치) · 데이터는 내 컴퓨터의 ~/.claude/projects에서만 읽었어요`;

  $('report').classList.remove('hidden');
}

function renderOnboarding(r: UsageReport): void {
  $('report').classList.add('hidden');
  $('subtitle').textContent = '분석할 기록이 없어요';
  const steps = $('onboarding-steps');
  const hasBinary = !!r.env.claudeBinary;
  steps.innerHTML = [
    hasBinary
      ? `<li>Claude Code 설치 확인 완료 (<code>${esc(r.env.claudeBinary!)}</code>)</li>`
      : `<li>Claude Code 설치: 터미널에서 <code>npm install -g @anthropic-ai/claude-code</code></li>`,
    `<li>프로젝트 폴더에서 <code>claude</code> 실행 후 로그인(<code>/login</code>)</li>`,
    `<li>첫 작업 해보기: <code>/init</code>으로 CLAUDE.md를 만들고, 작은 작업 하나를 시켜보세요</li>`,
    `<li>일주일쯤 쓰고 다시 분석하기를 눌러보세요. 사용 패턴을 진단해드려요</li>`,
  ].join('');
  $('onboarding').classList.remove('hidden');
}

function renderLevel(r: UsageReport): void {
  const avg = r.scores.reduce((a, s) => a + s.score, 0) / Math.max(1, r.scores.length);
  let lv = 'Lv.1 입문';
  let desc = 'AI와 첫 합 맞추는 중';
  if (avg >= 80) {
    lv = 'Lv.5 마스터';
    desc = '크루에게 가르쳐줄 수준';
  } else if (avg >= 68) {
    lv = 'Lv.4 숙련';
    desc = '낭비 없이 부려 쓰는 중';
  } else if (avg >= 55) {
    lv = 'Lv.3 활용';
    desc = '쓸 줄 아는데 더 아낄 수 있어요';
  } else if (avg >= 40) {
    lv = 'Lv.2 적응';
    desc = '기본기를 다지는 중';
  }
  $('level').innerHTML = `${esc(lv)} <span class="lv-desc">${esc(desc)} · 평균 ${Math.round(avg)}점</span>`;
}

function renderAxes(r: UsageReport): void {
  $('axes').innerHTML = r.scores
    .map(
      (s) => `
    <div class="axis-row">
      <span class="name">${esc(s.axis)}</span>
      <div class="track"><div class="fill" style="width:${s.score}%"></div></div>
      <span class="val">${s.score}점</span>
    </div>`
    )
    .join('');
}

function renderMetrics(r: UsageReport): void {
  const cards: { k: string; v: string; cls?: string }[] = [
    { k: '총 토큰', v: fmtTokens(r.totals.all) },
    { k: '캐시 적중률', v: Math.round(r.cacheHitRate * 100) + '%' },
    { k: '캐시로 아낀 비용', v: fmtUSD(r.estSavedUSD), cls: 'good' },
    { k: '사용자 중단', v: r.behavior.interruptions + '회' },
    { k: '평균 세션 길이', v: Math.round(r.behavior.avgSessionMin) + '분' },
  ];
  $('metrics').innerHTML = cards
    .map(
      (c) => `
    <div class="stat">
      <p class="k">${esc(c.k)}</p>
      <p class="v ${c.cls ?? ''}">${esc(c.v)}</p>
    </div>`
    )
    .join('');
}

function renderCategories(r: UsageReport): void {
  $('categories').innerHTML = r.categories
    .map(
      (c) => `
    <div class="axis-row">
      <span class="name">${esc(c.name)}</span>
      <div class="track"><div class="fill" style="width:${c.pct}%"></div></div>
      <span class="val">${c.pct}% (${c.sessions}회)</span>
    </div>`
    )
    .join('');
}

// 구버전 저장본에는 activities/inventory가 없을 수 있어 블록 단위로 숨긴다
function renderActivities(r: UsageReport): void {
  const actBlock = $('activities-block');
  const toolsBlock = $('tools-block');
  if (!r.activities || r.activities.length === 0) {
    actBlock.classList.add('hidden');
    toolsBlock.classList.add('hidden');
    return;
  }
  actBlock.classList.remove('hidden');
  toolsBlock.classList.remove('hidden');
  $('activities').innerHTML = r.activities
    .map(
      (a) => `
    <div class="axis-row" title="메시지 ${a.msgs.toLocaleString()}개 · 출력 토큰 ${fmtTokens(a.output)}">
      <span class="name">${esc(a.name)}</span>
      <div class="track"><div class="fill" style="width:${a.pct}%"></div></div>
      <span class="val">${a.pct}% · ${fmtTokens(a.total)}</span>
    </div>`
    )
    .join('');
  $('tool-top').innerHTML = (r.toolTop ?? [])
    .map(
      (t) =>
        `<div class="tool-row"><code>${esc(shortTool(t.name))}</code><span class="num">${t.n.toLocaleString()}</span></div>`
    )
    .join('');
}

function shortTool(n: string): string {
  const m = n.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]}:${m[2]}` : n;
}

function renderInventory(r: UsageReport): void {
  const card = $('inventory-card');
  if (!r.inventory) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const inv = r.inventory;
  const kb = (b: number): string => (b >= 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B');
  const invRow = (name: string, ok: boolean, extra: string): string =>
    `<div class="inv-row"><span class="inv-name">${esc(name)}</span><span class="inv-val ${ok ? 'ok' : 'dim'}">${ok ? '✓ ' + esc(extra) : '없음'}</span></div>`;

  $('inv-claudemd').innerHTML = [
    invRow('전역 ~/.claude', inv.globalClaudeMd.exists, kb(inv.globalClaudeMd.bytes)),
    ...inv.projectClaudeMds.map((p) => invRow(p.project, p.has, kb(p.bytes))),
  ].join('');

  $('inv-skills').innerHTML = inv.skills.length
    ? inv.skills
        .map(
          (s) => `
      <div class="inv-row" title="${esc(s.description)}">
        <span class="inv-name">${esc(s.name)}</span>
        <span class="inv-val ${s.uses === 0 ? 'dim' : ''}">${s.uses}회</span>
      </div>`
        )
        .join('')
    : '<p class="hint">~/.claude/skills에 스킬이 없어요</p>';

  $('inv-hooks').innerHTML = inv.hooks.length
    ? inv.hooks
        .map(
          (h) => `
      <div class="inv-row" title="matcher: ${esc(h.matcher || '(전체)')}">
        <span class="inv-name">${esc(h.event)}</span>
        <span class="inv-val">${esc(h.command)}</span>
      </div>`
        )
        .join('')
    : '<p class="hint">설정된 훅이 없어요</p>';
}

function renderRecs(
  container: HTMLElement,
  recs: { title: string; now: string; better: string; script: string; severity?: string }[],
  isOpus: boolean
): void {
  container.innerHTML = recs
    .map((rec, i) => {
      const sev = isOpus
        ? '<span class="sev opus">opus</span>'
        : `<span class="sev ${rec.severity === 'high' ? 'high' : 'mid'}">${rec.severity === 'high' ? '효과 큼' : '추천'}</span>`;
      return `
    <div class="rec">
      <p class="rec-title">${isOpus ? '소견' : '권고'} ${i + 1} · ${esc(rec.title)}${sev}</p>
      <p class="line"><strong>현재</strong>${esc(rec.now)}</p>
      <p class="line"><strong>권고</strong>${esc(rec.better)}</p>
      <div class="script-row">
        <code title="${esc(rec.script)}">${esc(rec.script)}</code>
        <button data-copy="${esc(rec.script)}">복사</button>
      </div>
    </div>`;
    })
    .join('');
}

document.body.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'BUTTON' && target.dataset.copy) {
    void window.api.copy(target.dataset.copy);
    const old = target.textContent;
    target.textContent = '복사됨';
    setTimeout(() => {
      target.textContent = old;
    }, 1400);
  }
});

async function coach(): Promise<void> {
  const btn = $('btn-coach') as HTMLButtonElement;
  btn.disabled = true;
  const body = $('coach-body');
  body.innerHTML = '<p class="spinner">opus가 사용 패턴을 읽는 중… (최대 3분)</p>';
  let c: Coaching;
  try {
    c = await window.api.coach();
  } catch (e) {
    body.innerHTML = `<div class="error-box">호출 실패: ${esc(String(e))}</div>`;
    btn.disabled = false;
    return;
  }
  btn.disabled = false;

  if (c.status === 'not_logged_in') {
    body.innerHTML = `<div class="error-box">claude CLI가 로그인돼 있지 않아요. 터미널에서 <b>claude</b> 실행 → <b>/login</b> 한 번만 해주세요. (구독 계정 선택)</div>`;
    return;
  }
  if (c.status === 'no_binary') {
    body.innerHTML = `<div class="error-box">${esc(c.message ?? 'claude CLI를 찾지 못했어요.')}</div>`;
    return;
  }
  if (c.status !== 'ok') {
    body.innerHTML = `<div class="error-box">${esc(c.message ?? '알 수 없는 오류')}</div>`;
    return;
  }

  let html = '';
  if (c.summary) html += `<div class="summary">${esc(c.summary)}</div>`;
  html += '<div id="coach-recs"></div>';
  if (c.promptRewrites && c.promptRewrites.length) {
    html += '<p class="sub-title gap-top">내 프롬프트 다시 쓰기</p>';
    html += c.promptRewrites
      .map(
        (rw) => `
      <div class="rewrite">
        <p><span class="score-pill">${rw.score}/10</span><span class="orig">${esc(rw.original)}</span></p>
        <p><span class="arrow">→</span>${esc(rw.better)}</p>
      </div>`
      )
      .join('');
  }
  body.innerHTML = html;
  const recsEl = document.getElementById('coach-recs');
  if (recsEl && c.recommendations) renderRecs(recsEl, c.recommendations, true);
}

// ---- 이전 결과(스냅샷) ----

async function loadHistory(): Promise<void> {
  const sel = $('history-select') as HTMLSelectElement;
  try {
    const items = await window.api.history();
    const current = sel.value;
    sel.innerHTML =
      '<option value="">이전 결과</option>' +
      items.map((it) => `<option value="${it.date}">${it.date} · 평균 ${it.avgScore}점</option>`).join('');
    sel.value = current && items.some((i) => i.date === current) ? current : '';
  } catch {
    // 목록 실패는 치명적이지 않다
  }
}

async function viewSnapshot(date: string): Promise<void> {
  const r = await window.api.snapshot(date);
  if (!r) return;
  render(r, date);
}

$('history-select').addEventListener('change', () => {
  const sel = $('history-select') as HTMLSelectElement;
  if (sel.value) void viewSnapshot(sel.value);
});
$('btn-analyze').addEventListener('click', () => void analyze());
$('btn-coach').addEventListener('click', () => void coach());

// 앱을 열면 바로 분석한다
void loadHistory();
void analyze();
