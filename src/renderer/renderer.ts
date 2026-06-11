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

// ---- 차트 공통 ----

const PALETTE = ['#3c5374', '#25683f', '#9c5a06', '#a63434', '#5b5a8c', '#2f6d6a', '#7a4a64', '#b08968'];
const GRAY = '#9a978f';

// '기타' 류는 항상 회색으로 고정해, 색이 의미를 갖게 한다
function colorFor(name: string, i: number): string {
  if (name.startsWith('기타')) return GRAY;
  return PALETTE[i % PALETTE.length];
}

interface DonutPart {
  name: string;
  value: number;
  color: string;
  tip: string;
}

function donutSVG(parts: DonutPart[], centerValue: string, centerLabel: string): string {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return '';
  const R = 44;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const segs = parts
    .map((p) => {
      const off = acc / total;
      acc += p.value;
      const len = (p.value / total) * C;
      if (len < 0.8) return ''; // 너무 얇은 조각은 그리지 않는다 (목록에는 남음)
      return `<circle r="${R}" cx="66" cy="66" fill="none" stroke="${p.color}" stroke-width="15"
        stroke-dasharray="${Math.max(0.5, len - 1.4).toFixed(2)} ${C.toFixed(2)}"
        stroke-dashoffset="${(-off * C).toFixed(2)}"><title>${esc(p.tip)}</title></circle>`;
    })
    .join('');
  return `<svg viewBox="0 0 132 132" role="img">
    <g transform="rotate(-90 66 66)">${segs}</g>
    <text x="66" y="63" text-anchor="middle" font-size="15" font-weight="700" fill="var(--ink)">${esc(centerValue)}</text>
    <text x="66" y="79" text-anchor="middle" font-size="9.5" fill="var(--muted)">${esc(centerLabel)}</text>
  </svg>`;
}

function radarSVG(scores: { axis: string; score: number }[]): string {
  const n = scores.length;
  if (n < 3) return '';
  const cx = 160;
  const cy = 122;
  const R = 78;
  const pt = (i: number, r: number): [number, number] => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const ring = (v: number): string =>
    `<polygon points="${scores.map((_, i) => pt(i, (R * v) / 100).map((c) => c.toFixed(1)).join(',')).join(' ')}"
      fill="${v === 100 ? '#fbfaf7' : 'none'}" stroke="var(--line)" stroke-width="1"/>`;
  const spokes = scores
    .map((_, i) => {
      const [x, y] = pt(i, R);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"/>`;
    })
    .join('');
  const poly = scores.map((s, i) => pt(i, (R * s.score) / 100).map((c) => c.toFixed(1)).join(',')).join(' ');
  const dots = scores
    .map((s, i) => {
      const [x, y] = pt(i, (R * s.score) / 100);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="var(--bar)"><title>${esc(s.axis)} ${s.score}점</title></circle>`;
    })
    .join('');
  const labels = scores
    .map((s, i) => {
      const [x, y] = pt(i, R + 13);
      const dx = x - cx;
      const anchor = Math.abs(dx) < 12 ? 'middle' : dx > 0 ? 'start' : 'end';
      const dy = y < cy - R * 0.6 ? -2 : y > cy + R * 0.5 ? 8 : 4;
      return `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}" font-size="10.5" fill="var(--ink)">${esc(s.axis)}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 320 244" role="img">
    ${ring(100)}${ring(75)}${ring(50)}${ring(25)}${spokes}
    <polygon points="${poly}" fill="rgba(60,83,116,0.16)" stroke="var(--bar)" stroke-width="1.6"/>
    ${dots}${labels}
  </svg>`;
}

function dailyChartSVG(daily: { date: string; tokens: number }[]): string {
  if (!daily.length) return '';
  const W = 724;
  const H = 128;
  const base = 100;
  const max = Math.max(...daily.map((d) => d.tokens));
  if (max <= 0) return '';
  const step = W / daily.length;
  const barW = Math.min(16, step * 0.62);
  const bars = daily
    .map((d, i) => {
      const h = d.tokens > 0 ? Math.max(2, (d.tokens / max) * (base - 14)) : 0;
      const x = i * step + (step - barW) / 2;
      const label = `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}`;
      const bar = h > 0
        ? `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--bar)" opacity="${d.tokens === max ? 1 : 0.78}"><title>${label} · ${fmtTokens(d.tokens)} 토큰</title></rect>`
        : '';
      const tick = i % 5 === 0 || i === daily.length - 1
        ? `<text x="${(i * step + step / 2).toFixed(1)}" y="${base + 16}" text-anchor="middle" font-size="9.5" fill="var(--muted)">${label}</text>`
        : '';
      return bar + tick;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img">
    <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="var(--line)" stroke-width="1"/>
    <text x="${W}" y="10" text-anchor="end" font-size="9.5" fill="var(--muted)">하루 최대 ${esc(fmtTokens(max))}</text>
    ${bars}
  </svg>`;
}

// 도구를 성격별로 묶어 색을 입힌다. 이름만으로는 뭐 하는 도구인지 안 보여서.
const TOOL_GROUPS: { label: string; color: string; re: RegExp }[] = [
  { label: '읽기·탐색', color: '#25683f', re: /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch)$/ },
  { label: '파일 수정', color: '#3c5374', re: /^(Edit|Write|NotebookEdit)$/ },
  { label: '터미널', color: '#9c5a06', re: /^Bash$/ },
  { label: '작업·대화', color: '#5b5a8c', re: /^(Task\w*|TodoWrite|AskUserQuestion|Skill|Agent|ToolSearch|ExitPlanMode|EnterPlanMode)$/ },
  { label: 'MCP 연동', color: '#2f6d6a', re: /^mcp__/ },
];
const TOOL_OTHER = { label: '기타', color: GRAY };

function toolGroup(name: string): { label: string; color: string } {
  for (const g of TOOL_GROUPS) if (g.re.test(name)) return g;
  return TOOL_OTHER;
}

function shortModel(m: string): string {
  const full = m.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (full) return `${full[1]} ${full[2]}.${full[3]}`;
  const major = m.match(/^claude-([a-z]+)-(\d+)/);
  if (major) return `${major[1]} ${major[2]}`;
  return m;
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
  renderDaily(r);
  renderModelMix(r);
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
  $('radar').innerHTML = radarSVG(r.scores);
  // desc/detail: 축이 뭘 재는지 + 이번 측정의 실제 입력값 (구버전 스냅샷에는 없어서 막대만 그린다)
  $('axes').innerHTML = r.scores
    .map(
      (s) => `
    <div class="axis-item">
      <div class="axis-row">
        <span class="name">${esc(s.axis)}</span>
        <div class="track"><div class="fill" style="width:${s.score}%"></div></div>
        <span class="val">${s.score}점</span>
      </div>
      ${s.desc ? `<div class="axis-sub">${esc(s.desc)}</div>` : ''}
      ${s.detail ? `<div class="axis-detail">${esc(s.detail)}</div>` : ''}
    </div>`
    )
    .join('');
}

// 구버전 스냅샷에는 daily가 없으니 블록째 숨긴다
function renderDaily(r: UsageReport): void {
  const block = $('daily-block');
  const svg = r.daily && r.daily.length ? dailyChartSVG(r.daily) : '';
  if (!svg) {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  $('daily-chart').innerHTML = svg;
}

function renderModelMix(r: UsageReport): void {
  const block = $('model-block');
  const mix = (r.modelMix ?? []).filter((m) => m.tokens > 0);
  const total = mix.reduce((a, m) => a + m.tokens, 0);
  if (total <= 0) {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  const segs = mix
    .map((m, i) => {
      const w = (m.tokens / total) * 100;
      if (w < 0.4) return '';
      return `<div class="seg" style="width:${w.toFixed(2)}%;background:${colorFor(m.model, i)}" title="${esc(shortModel(m.model))} ${m.pct}%"></div>`;
    })
    .join('');
  const legend = mix
    .map(
      (m, i) =>
        `<span class="leg-item"><span class="dot" style="background:${colorFor(m.model, i)}"></span>${esc(shortModel(m.model))} ${m.pct}% · ${esc(fmtTokens(m.tokens))}</span>`
    )
    .join('');
  $('model-mix').innerHTML = `<div class="stack-bar">${segs}</div><div class="stack-legend">${legend}</div>`;
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
  $('cat-donut').innerHTML = donutSVG(
    r.categories.map((c, i) => ({
      name: c.name,
      value: c.sessions,
      color: colorFor(c.name, i),
      tip: `${c.name} ${c.pct}% (${c.sessions}회)`,
    })),
    String(r.sessions),
    '세션'
  );
  $('categories').innerHTML = r.categories
    .map((c, i) => {
      // 이 분야가 실제 어떤 폴더의 세션인지 펼쳐 보여준다
      let sub = '';
      if (c.projects && c.projects.length) {
        const shown = c.projects.map((p) => `${esc(p.name)} ${p.sessions}`).join(' · ');
        const rest = c.sessions - c.projects.reduce((a, p) => a + p.sessions, 0);
        sub = `<p class="leg-sub">${shown}${rest > 0 ? ` · 그 외 ${rest}회` : ''}</p>`;
      }
      return `
    <div class="leg-row">
      <div class="leg-head">
        <span class="dot" style="background:${colorFor(c.name, i)}"></span>
        <span class="leg-name">${esc(c.name)}</span>
        <span class="leg-val">${c.pct}% · ${c.sessions}회</span>
      </div>
      ${sub}
    </div>`;
    })
    .join('');
}

// 각 활동이 실제로 무엇을 뜻하는지 한 줄 설명 (분류 규칙과 1:1)
const ACT_DESC: Record<string, string> = {
  '대화·설계': '파일·도구 없이 말로만 답한 턴. 질문 답변, 설계 논의',
  '명령 실행': '터미널 명령을 돌린 턴. 빌드·테스트·git·파일 탐색',
  '코드 읽기·검수': '파일을 읽고 검색만 한 턴. 수정 없음',
  '서버·스크립트 코드': '로직·서버 코드 파일을 고친 턴',
  '프론트 코드': '화면 쪽 파일을 고친 턴',
  '문서·설정 파일': '문서·설정 파일을 고친 턴',
  '컴퓨터·브라우저 제어': '화면을 직접 클릭·조작한 턴',
  '기타 도구': '그 외 도구를 쓴 턴. 스킬·서브에이전트 등',
};

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
  const actTotal = r.activities.reduce((a, x) => a + x.total, 0);
  $('act-donut').innerHTML = donutSVG(
    r.activities.map((a, i) => ({
      name: a.name,
      value: a.total,
      color: colorFor(a.name, i),
      tip: `${a.name} ${a.pct}% (${fmtTokens(a.total)} 토큰)`,
    })),
    fmtTokens(actTotal),
    '토큰'
  );
  $('activities').innerHTML = r.activities
    .map((a, i) => {
      const desc = ACT_DESC[a.name] ?? '';
      // 실제 내용물 상위 항목: 명령 실행이면 명령어, 파일 작업이면 확장자
      const keys = Object.keys(a.details ?? {}).slice(0, 3);
      const items = keys.length
        ? '주로 ' + keys.map((k) => (a.name === '명령 실행' ? k : '.' + k)).join('·')
        : '';
      const sub = desc || items ? `<p class="leg-sub">${esc(desc)}${desc && items ? ' · ' : ''}${esc(items)}</p>` : '';
      return `
    <div class="leg-row" title="메시지 ${a.msgs.toLocaleString()}개 · 출력 토큰 ${fmtTokens(a.output)}">
      <div class="leg-head">
        <span class="dot" style="background:${colorFor(a.name, i)}"></span>
        <span class="leg-name">${esc(a.name)}</span>
        <span class="leg-val">${a.pct}% · ${fmtTokens(a.total)}</span>
      </div>
      ${sub}
    </div>`;
    })
    .join('');
  const tools = r.toolTop ?? [];
  const maxN = Math.max(1, ...tools.map((t) => t.n));
  $('tool-top').innerHTML = tools
    .map((t) => {
      const g = toolGroup(t.name);
      // sqrt 스케일: 1등(Bash)이 압도해도 꼬리가 보이게
      const w = Math.sqrt(t.n / maxN) * 100;
      return `
    <div class="tool-row2" title="${esc(t.name)} · ${esc(g.label)}">
      <code class="t-name">${esc(shortTool(t.name))}</code>
      <div class="t-track"><div class="t-fill" style="width:${w.toFixed(1)}%;background:${g.color}"></div></div>
      <span class="t-num">${t.n.toLocaleString()}</span>
    </div>`;
    })
    .join('');
  const seen = new Set(tools.map((t) => toolGroup(t.name).label));
  $('tool-legend').innerHTML = [...TOOL_GROUPS, TOOL_OTHER]
    .filter((g) => seen.has(g.label))
    .map((g) => `<span class="leg-item"><span class="dot" style="background:${g.color}"></span>${esc(g.label)}</span>`)
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

  // CLAUDE.md: 상태 점 + 작성 현황 요약
  const mdRows = [
    { name: '전역 ~/.claude', has: inv.globalClaudeMd.exists, bytes: inv.globalClaudeMd.bytes },
    ...inv.projectClaudeMds.map((p) => ({ name: p.project, has: p.has, bytes: p.bytes })),
  ];
  const mdDone = mdRows.filter((m) => m.has).length;
  $('inv-claudemd').innerHTML =
    `<p class="inv-sum">${mdDone}/${mdRows.length}곳 작성됨</p>` +
    mdRows
      .map(
        (m) => `
      <div class="inv-row">
        <span class="st ${m.has ? 'on' : 'off'}"></span>
        <span class="inv-name">${esc(m.name)}</span>
        <span class="inv-val ${m.has ? 'ok' : 'dim'}">${m.has ? esc(kb(m.bytes)) : '없음'}</span>
      </div>`
      )
      .join('');

  // 스킬: 호출 횟수를 미니 막대로
  const usedSkills = inv.skills.filter((s) => s.uses > 0).length;
  const maxUses = Math.max(1, ...inv.skills.map((s) => s.uses));
  $('inv-skills').innerHTML = inv.skills.length
    ? `<p class="inv-sum">${inv.skills.length}개 중 ${usedSkills}개 호출됨</p>` +
      inv.skills
        .map((s) => {
          const w = s.uses > 0 ? Math.max(6, Math.sqrt(s.uses / maxUses) * 100) : 0;
          return `
      <div class="inv-row" title="${esc(s.description)}">
        <span class="inv-name ${s.uses === 0 ? 'dim-name' : ''}">${esc(s.name)}</span>
        <div class="s-track">${w > 0 ? `<div class="s-fill" style="width:${w.toFixed(0)}%"></div>` : ''}</div>
        <span class="inv-val ${s.uses === 0 ? 'dim' : ''}">${s.uses}회</span>
      </div>`;
        })
        .join('')
    : '<p class="hint">~/.claude/skills에 스킬이 없어요</p>';

  // 훅: 이벤트 배지 + 스크립트 칩
  $('inv-hooks').innerHTML = inv.hooks.length
    ? `<p class="inv-sum">${inv.hooks.length}개 설정됨</p>` +
      inv.hooks
        .map(
          (h) => `
      <div class="hook-chip" title="matcher: ${esc(h.matcher || '(전체)')}">
        <span class="hk-event">${esc(h.event)}</span>
        <code class="hk-cmd">${esc(h.command)}</code>
      </div>`
        )
        .join('')
    : '<p class="hint">설정된 훅이 없어요<br/>반복 확인(린트·알림)을 자동화할 수 있어요</p>';
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
