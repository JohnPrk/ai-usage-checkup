// DOM lib에 동명의 Report 인터페이스가 있어 UsageReport로 구분한다
type UsageReport = Awaited<ReturnType<typeof window.api.analyze>>;

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

const PALETTE = ['#4a78d0', '#2ea35c', '#e0902a', '#e35d54', '#8268d8', '#26b3a8', '#d364a0', '#caa23f'];
const GRAY = '#a8a59c';

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
  const R = 56;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const segs = parts
    .map((p) => {
      const off = acc / total;
      acc += p.value;
      const len = (p.value / total) * C;
      if (len < 0.8) return ''; // 너무 얇은 조각은 그리지 않는다 (목록에는 남음)
      return `<circle r="${R}" cx="80" cy="80" fill="none" stroke="${p.color}" stroke-width="18"
        stroke-dasharray="${Math.max(0.5, len - 1.6).toFixed(2)} ${C.toFixed(2)}"
        stroke-dashoffset="${(-off * C).toFixed(2)}"><title>${esc(p.tip)}</title></circle>`;
    })
    .join('');
  return `<svg viewBox="0 0 160 160" role="img">
    <g transform="rotate(-90 80 80)">${segs}</g>
    <text x="80" y="76" text-anchor="middle" font-size="23" font-weight="700" fill="var(--ink)">${esc(centerValue)}</text>
    <text x="80" y="95" text-anchor="middle" font-size="11.5" fill="var(--muted)">${esc(centerLabel)}</text>
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
  { label: '읽기·탐색', color: '#2ea35c', re: /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch)$/ },
  { label: '파일 수정', color: '#4a78d0', re: /^(Edit|Write|NotebookEdit)$/ },
  { label: '터미널', color: '#e0902a', re: /^Bash$/ },
  { label: '작업·대화', color: '#8268d8', re: /^(Task\w*|TodoWrite|AskUserQuestion|Skill|Agent|ToolSearch|ExitPlanMode|EnterPlanMode)$/ },
  { label: 'MCP 연동', color: '#26b3a8', re: /^mcp__/ },
];
const TOOL_OTHER = { label: '기타', color: GRAY };

function toolGroup(name: string): { label: string; color: string } {
  for (const g of TOOL_GROUPS) if (g.re.test(name)) return g;
  return TOOL_OTHER;
}

function groupColor(label: string): string {
  return TOOL_GROUPS.find((g) => g.label === label)?.color ?? TOOL_OTHER.color;
}

// 구버전 스냅샷(toolGroups 없음)용: 상위 도구만으로 성격별 비중을 근사한다
function groupsFromTop(tools: { name: string; n: number }[]): { label: string; n: number; pct: number }[] {
  const m = new Map<string, number>();
  let total = 0;
  for (const t of tools) {
    total += t.n;
    const label = toolGroup(t.name).label;
    m.set(label, (m.get(label) ?? 0) + t.n);
  }
  return [...m.entries()]
    .map(([label, n]) => ({ label, n, pct: total > 0 ? Math.round((n / total) * 100) : 0 }))
    .sort((a, b) => b.n - a.n);
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
  $('home').classList.add('hidden');
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
  $('home').classList.add('hidden');
  $('doc-actions').classList.remove('hidden');
  $('subtitle').textContent = snapshotDate
    ? `${snapshotDate} 저장본 · 세션 ${r.sessions.toLocaleString()}개`
    : `분석일 ${r.generatedAt.slice(0, 10)} · 최근 ${r.days}일 · 세션 ${r.sessions.toLocaleString()}개`;

  renderLevel(r);
  renderAxes(r);
  renderCriteria(r);
  renderMetrics(r);
  renderDaily(r);
  renderModelMix(r);
  renderCategories(r);
  renderActivities(r);
  renderInventory(r);
  renderFeatureCoverage(r);
  renderRecs($('recs'), r.recommendations, false);

  $('meta').textContent =
    `파일 ${r.files}개 · 건너뛴 라인 ${r.skippedLines.toLocaleString()}개 · ` +
    `예상 사용 비용 ${fmtUSD(r.estCostUSD)} (API 환산 참고치) · 데이터는 내 컴퓨터의 ~/.claude/projects에서만 읽었어요`;

  $('report').classList.remove('hidden');
}

function renderOnboarding(r: UsageReport): void {
  $('report').classList.add('hidden');
  $('home').classList.add('hidden');
  $('doc-actions').classList.remove('hidden');
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
  // desc는 항상 보이고, 실제 수치(detail)는 번잡해서 기본 접어둔다 → 클릭하면 펼침 (구버전 스냅샷엔 detail 없음)
  $('axes').innerHTML = r.scores
    .map((s) => {
      const hasDetail = !!s.detail;
      const toggle = hasDetail ? ' <span class="axis-toggle">수치 <span class="arrow">▾</span></span>' : '';
      const sub = s.desc || hasDetail ? `<div class="axis-sub">${esc(s.desc ?? '')}${toggle}</div>` : '';
      return `
    <div class="axis-item${hasDetail ? ' has-detail' : ''}">
      <div class="axis-row">
        <span class="name">${esc(s.axis)}</span>
        <div class="track"><div class="fill" style="width:${s.score}%"></div></div>
        <span class="val">${s.score}점</span>
      </div>
      ${sub}
      ${hasDetail ? `<div class="axis-detail">${esc(s.detail!)}</div>` : ''}
    </div>`;
    })
    .join('');
}

// 점수 기준 팝업: 리포트에 실린 그 시점의 기준을 그대로 보여준다 (구버전 스냅샷에는 없어 버튼을 숨긴다)
function renderCriteria(r: UsageReport): void {
  const btn = $('btn-criteria');
  const crits = r.scoreCriteria;
  if (!crits || crits.length === 0) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  $('criteria-body').innerHTML = crits
    .map(
      (c) => `
    <div class="crit">
      <p class="crit-axis">${esc(c.axis)}<span class="crit-what">${esc(c.what)}</span></p>
      <p class="crit-base">${esc(c.base)}</p>
      <ul>
        ${c.gains.map((g) => `<li class="crit-gain">+ ${esc(g)}</li>`).join('')}
        ${c.penalties.map((p) => `<li class="crit-pen">− ${esc(p)}</li>`).join('')}
      </ul>
      ${
        c.sources && c.sources.length
          ? `<div class="crit-src"><span class="crit-src-h">근거</span><ul>${c.sources
              .map(
                (s) =>
                  `<li><a class="crit-src-link" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a><span class="crit-src-g">${esc(s.grounds)}</span></li>`
              )
              .join('')}</ul></div>`
          : ''
      }
      ${c.calibrationNote ? `<p class="crit-cal">${esc(c.calibrationNote)}</p>` : ''}
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
    .map(
      (c, i) => `
    <div class="leg-row">
      <div class="leg-head">
        <span class="dot" style="background:${colorFor(c.name, i)}"></span>
        <span class="leg-name">${esc(c.name)}</span>
        <span class="leg-val">${c.pct}% · ${c.sessions}회</span>
      </div>
    </div>`
    )
    .join('');

  // 프로젝트 '결' (우테코 미션 vs 개인 프로젝트) — 그래프 없이 작은 행으로
  const pt = r.projectTypes ?? [];
  const ptEl = $('project-types');
  if (pt.length) {
    ptEl.classList.remove('hidden');
    ptEl.innerHTML =
      `<p class="ptype-title">프로젝트 종류 <span class="hint">세션이 열린 폴더 기준</span></p>` +
      pt
        .map((t) => {
          const subs = t.projects ?? [];
          const shown = subs.map((p) => `${esc(p.name)} ${p.sessions}`).join(' · ');
          const rest = t.sessions - subs.reduce((a, p) => a + p.sessions, 0);
          const sub = shown ? `<p class="ptype-sub">${shown}${rest > 0 ? ` · 그 외 ${rest}` : ''}</p>` : '';
          return `
      <div class="ptype-item">
        <div class="ptype-row">
          <span class="ptype-name">${esc(t.label)}</span>
          <span class="ptype-val">${t.pct}% · ${t.sessions}회</span>
        </div>
        ${sub}
      </div>`;
        })
        .join('');
  } else {
    ptEl.classList.add('hidden');
  }
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

  // 성격별 비중 요약 (전체 호출 기준). 신버전은 r.toolGroups, 구버전 스냅샷은 상위 도구로 폴백 집계
  const groups = r.toolGroups?.length ? r.toolGroups : groupsFromTop(tools);
  // 그래프 대신 한 줄 텍스트: 색점 + 라벨 + % (정확한 호출 수는 hover)
  const gLine = groups
    .map(
      (g) =>
        `<span class="tg-item" title="${esc(g.label)} ${g.n.toLocaleString()}회"><span class="tg-dot" style="background:${groupColor(g.label)}"></span>${esc(g.label)} <b>${g.pct}%</b></span>`
    )
    .join('<span class="tg-sep">·</span>');
  $('tool-groups').innerHTML = `<p class="tool-mix">${gLine}</p>`;

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

  // CLAUDE.md: 바탕화면·홈에서 훑어 '있는 곳'만 보여준다. 상위 폴더 상속분(woowa_course 등)은 출처를 덧붙인다.
  const mdScanned = [
    { name: '전역 ~/.claude', has: inv.globalClaudeMd.exists, bytes: inv.globalClaudeMd.bytes, note: '' },
    ...inv.projectClaudeMds.map((p) => ({
      name: p.project,
      has: p.has,
      bytes: p.bytes,
      note: p.has && p.foundAt && p.foundAt !== p.cwd ? `${p.foundAt.split('/').filter(Boolean).pop() ?? ''}/ 상속` : '',
    })),
  ];
  const mdShown = mdScanned.filter((m) => m.has);
  $('inv-claudemd').innerHTML =
    `<p class="inv-sum">${mdShown.length}/${mdScanned.length}곳에 있음 <span class="hint">바탕화면·홈 탐색</span></p>` +
    (mdShown.length
      ? mdShown
          .map(
            (m) => `
      <div class="inv-row"${m.note ? ` title="${esc(m.note)}"` : ''}>
        <span class="st on"></span>
        <span class="inv-name">${esc(m.name)}${m.note ? ` <span class="inv-note">${esc(m.note)}</span>` : ''}</span>
        <span class="inv-val ok">${esc(kb(m.bytes))}</span>
      </div>`
          )
          .join('')
      : '<p class="hint">아직 CLAUDE.md가 없어요 — 자주 쓰는 폴더에 두면 매번 설명을 안 해도 돼요</p>');

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

// 공식 기능 커버리지: 어떤 공식 기능을 쓰고 안 쓰는지 칩으로 (기능 활용도 점수의 근거). 구버전 스냅샷엔 없어 숨긴다
function renderFeatureCoverage(r: UsageReport): void {
  const el = $('feature-coverage');
  const fc = r.featureCoverage;
  if (!fc || !fc.length) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const used = fc.filter((f) => f.used).length;
  el.innerHTML =
    `<div class="fc-head"><span class="fc-title">공식 기능 ${used}/${fc.length} 사용</span><span class="hint">기능 활용도 점수의 기준 · 안 쓰는 기능을 켜면 점수가 올라요</span></div>` +
    `<div class="fc-chips">` +
    fc
      .map((f) => `<span class="fc-chip ${f.used ? 'on' : 'off'}">${f.used ? '✓' : '＋'} ${esc(f.name)}</span>`)
      .join('') +
    `</div>`;
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

// ---- 시작 페이지 + 이전 결과(스냅샷) ----

type SnapItem = Awaited<ReturnType<typeof window.api.history>>[number];

// 분석 결과 대신 시작 화면을 보여준다 (앱 첫 진입, 제목 클릭)
function showHome(): void {
  $('report').classList.add('hidden');
  $('onboarding').classList.add('hidden');
  $('progress').classList.add('hidden');
  $('doc-actions').classList.add('hidden');
  $('home').classList.remove('hidden');
  $('subtitle').textContent = '시작하려면 분석하기를 눌러주세요';
}

function renderHomeHistory(items: SnapItem[]): void {
  const wrap = $('home-history');
  if (!items.length) {
    wrap.innerHTML = '<p class="muted">아직 저장된 결과가 없어요. 분석하기를 눌러 시작하세요.</p>';
    return;
  }
  wrap.innerHTML = items
    .map(
      (it) => `
      <button class="home-snap" data-date="${esc(it.date)}">
        <span class="home-snap-date">${esc(it.date)}</span>
        <span class="home-snap-meta">평균 ${it.avgScore}점 · 세션 ${it.sessions.toLocaleString()}개 · 토큰 ${fmtTokens(it.totalTokens)}</span>
      </button>`
    )
    .join('');
}

async function loadHistory(): Promise<void> {
  const sel = $('history-select') as HTMLSelectElement;
  try {
    const items = await window.api.history();
    const current = sel.value;
    sel.innerHTML =
      '<option value="">이전 결과</option>' +
      items.map((it) => `<option value="${it.date}">${it.date} · 평균 ${it.avgScore}점</option>`).join('');
    sel.value = current && items.some((i) => i.date === current) ? current : '';
    renderHomeHistory(items);
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
$('btn-home-analyze').addEventListener('click', () => void analyze());
$('app-title').addEventListener('click', () => showHome());
// 시작 화면의 이전 결과 카드 클릭 → 그 저장본 열기
$('home-history').addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest('.home-snap') as HTMLElement | null;
  if (card?.dataset.date) void viewSnapshot(card.dataset.date);
});
// 축의 실제 수치는 클릭하면 펼쳐진다
$('axes').addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest('.axis-item.has-detail') as HTMLElement | null;
  if (item) item.classList.toggle('show-detail');
});
// (작업 의도별 세션은 하위 프로젝트를 펼치지 않는다 — '프로젝트 종류'로 대체)
$('btn-criteria').addEventListener('click', () => $('criteria-modal').classList.remove('hidden'));
$('btn-criteria-close').addEventListener('click', () => $('criteria-modal').classList.add('hidden'));
$('criteria-modal').addEventListener('click', (e) => {
  if (e.target === $('criteria-modal')) $('criteria-modal').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('criteria-modal').classList.add('hidden');
});

// 앱을 열면 시작 화면을 보여준다 (분석은 사용자가 직접 시작)
void loadHistory();
showHome();
