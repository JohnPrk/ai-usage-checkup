// DOM lib에 동명의 Report 인터페이스가 있어 UsageReport로 구분한다.
// analyze는 폴더 미허용(MAS) 시 { status: 'need_access' }를 반환할 수 있어 그건 제외한다.
type UsageReport = Exclude<Awaited<ReturnType<typeof window.api.analyze>>, { status: string }>;
// 리더보드 뷰/행 타입 (renderer는 전역 스크립트라 import 대신 api 반환 타입에서 끌어온다)
type Leaderboard = NonNullable<Awaited<ReturnType<typeof window.api.leaderboard>>>;
type LbRow = Leaderboard['top'][number];

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing element: ' + id);
  return el;
};

let running = false;
// 현재 분석 대상: 클로드(~/.claude) vs 코덱스(~/.codex). render·인벤토리 라벨 분기에 쓴다
let currentSource: 'claude' | 'codex' = 'claude';
// 세부 수치 팝업이 참조할 현재 리포트 (구조화된 metrics를 data-attribute로 넘기기 어려워 인덱스로 조회)
let modalReport: UsageReport | null = null;
let currentReportDate: string | null = null;
let savingPdf = false;

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

// 채도를 낮춘 통일감 있는 팔레트 (무지개처럼 알록달록하지 않게)
const PALETTE = ['#5b7fab', '#5f9576', '#c39a63', '#bd7268', '#8079a8', '#5d9498', '#a87e94', '#9a8d5e'];
const GRAY = '#a8a59c';

// 점수 추이·이전 결과에서 도구를 색으로 구분한다 (클로드=네이비, 코덱스=저채도 슬레이트 블루)
const SOURCE_COLOR: Record<'claude' | 'codex', string> = { claude: '#3c5374', codex: '#586f84' };
const SOURCE_LABEL: Record<'claude' | 'codex', string> = { claude: 'Claude', codex: 'Codex' };

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

function donutSVG(parts: DonutPart[], centerValue: string, centerLabel: string, callouts = false): string {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return '';

  if (callouts) {
    // 링 중심(cx,cy)은 정중앙 고정. 가로 폭은 동적값을 HW_MIN으로 바닥 고정해 두 도넛 크기를 통일,
    // 세로는 라벨 양에 맞춰 동적. 라벨은 퍼센트(위)+이름(아래, 길면 줄바꿈)을 가운데 정렬한다.
    const cx = 345, cy = 205, R = 180, sw = 64;
    const lf = 19; // 라벨 글자 크기(viewBox 단위) — 작게 보여서 키움
    const C = 2 * Math.PI * R;
    const HW_MIN = 360; // viewBox 가로 반폭 바닥값 → 라벨이 짧아도 이 폭 유지(두 도넛 동일 크기)
    // 한글 1em, 숫자·영문 ~0.56em 등 대략 폭으로 라벨 길이를 추정해 배치한다.
    const textW = (s: string): number =>
      [...s].reduce((a, ch) => {
        if (/[가-힣]/.test(ch)) return a + 1.0;
        if (ch === '·' || ch === 'ㆍ') return a + 0.5;
        if (ch === '%') return a + 0.85;
        if (ch === ' ') return a + 0.3;
        if (ch === '(' || ch === ')') return a + 0.4;
        return a + 0.56;
      }, 0) * lf;
    // 이름이 WRAP_W를 넘으면 두 줄로(공백·가운뎃점 후보 중 두 줄 폭이 가장 균형 잡히는 곳에서 자름).
    const WRAP_W = lf * 5.5;
    const wrapName = (s: string): string[] => {
      if (textW(s) <= WRAP_W) return [s];
      const breaks: number[] = [];
      for (let i = 1; i < s.length; i++) {
        const ch = s[i - 1];
        if (ch === ' ' || ch === '·' || ch === 'ㆍ') breaks.push(i);
      }
      if (!breaks.length) breaks.push(Math.ceil(s.length / 2));
      let best = breaks[0], bestMax = Infinity;
      for (const b of breaks) {
        const m = Math.max(textW(s.slice(0, b).replace(/\s+$/, '')), textW(s.slice(b).replace(/^\s+/, '')));
        if (m < bestMax) { bestMax = m; best = b; }
      }
      return [s.slice(0, best).replace(/\s+$/, ''), s.slice(best).replace(/^\s+/, '')];
    };

    let acc = 0;
    const segs: string[] = [];
    const lineH = lf * 1.18; // 줄 간격
    // 라벨을 먼저 수집(세로 겹침 해소를 위해) → SVG로 변환한다.
    type Lab = { side: 1 | -1; x1: number; y1: number; x2: number; y2: number;
      ex: number; lines: string[]; w: number; color: string; bc: number; half: number };
    const labs: Lab[] = [];

    parts.forEach((p) => {
      const startFrac = acc / total;
      acc += p.value;
      const endFrac = acc / total;
      const len = (p.value / total) * C;
      if (len >= 0.8) {
        segs.push(`<circle r="${R}" cx="${cx}" cy="${cy}" fill="none" stroke="${p.color}" stroke-width="${sw}"
          stroke-dasharray="${Math.max(0.5, len - 1.6).toFixed(2)} ${C.toFixed(2)}"
          stroke-dashoffset="${(-(startFrac) * C).toFixed(2)}"><title>${esc(p.tip)}</title></circle>`);
      }
      const pct = Math.round((p.value / total) * 100);
      if (pct < 3) return;
      const midFrac = (startFrac + endFrac) / 2;
      const angle = midFrac * 2 * Math.PI - Math.PI / 2;
      const r1 = R + sw / 2 + 4;
      const r2 = R + sw / 2 + 60; // 리더선을 여백 쪽으로 더 길게 — 라벨을 링에서 띄워 좌우 여백에 적는다
      const x1 = cx + r1 * Math.cos(angle);
      const y1 = cy + r1 * Math.sin(angle);
      const x2 = cx + r2 * Math.cos(angle);
      const y2 = cy + r2 * Math.sin(angle);
      const side: 1 | -1 = x2 >= cx ? 1 : -1;
      // 줄 구성: 퍼센트(맨 위) + 이름(1~2줄). 가운데 정렬이라 폭은 가장 넓은 줄.
      const lines = [`${pct}%`, ...wrapName(p.name)];
      labs.push({
        side, x1, y1, x2, y2,
        ex: x2 + side * 14,                                 // 블록 안쪽(링 쪽) 가장자리 = 리더선 끝
        lines, w: Math.max(...lines.map(textW)), color: p.color,
        bc: y2,                                             // 블록 세로 중심(겹침 해소 전 초기값)
        half: ((lines.length - 1) / 2) * lineH + lf * 0.55, // 블록 반높이(줄 수에 비례)
      });
    });

    // 같은 쪽 라벨이 세로로 겹치지 않게 위→아래로 최소 간격 확보(줄 수마다 키가 달라 블록별 반높이 사용).
    for (const s of [1, -1] as const) {
      const col = labs.filter((l) => l.side === s).sort((a, b) => a.bc - b.bc);
      for (let i = 1; i < col.length; i++) {
        const need = col[i - 1].half + col[i].half + 5;
        if (col[i].bc - col[i - 1].bc < need) col[i].bc = col[i - 1].bc + need;
      }
    }

    // 라벨 → SVG. 가로 경계(HW_MIN으로 바닥 고정)와 세로 경계를 함께 넓힌다.
    const labels: string[] = [];
    let minX = cx - (R + sw / 2), maxX = cx + (R + sw / 2);
    let minY = cy - (R + sw / 2), maxY = cy + (R + sw / 2);
    for (const l of labs) {
      const lx = l.ex + (l.side * l.w) / 2;       // 가운데 정렬 기준 x(블록 중심)
      const far = l.ex + l.side * l.w;            // 블록 바깥쪽 가장자리
      minX = Math.min(minX, l.ex, far); maxX = Math.max(maxX, l.ex, far);
      minY = Math.min(minY, l.bc - l.half); maxY = Math.max(maxY, l.bc + l.half);
      const top = l.bc - ((l.lines.length - 1) / 2) * lineH; // 첫 줄 시각 중심
      const texts = l.lines
        .map((t, k) => {
          const big = k === 0;
          const y = top + k * lineH + lf * 0.35;
          return `<text x="${lx.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="${big ? lf + 1 : lf}" font-weight="${big ? 700 : 500}" fill="var(--ink)">${esc(t)}</text>`;
        })
        .join('');
      labels.push(`
        <polyline points="${l.x1.toFixed(1)},${l.y1.toFixed(1)} ${l.x2.toFixed(1)},${l.y2.toFixed(1)} ${l.ex.toFixed(1)},${l.bc.toFixed(1)}"
          fill="none" stroke="${l.color}" stroke-width="1.3" opacity="0.75"/>${texts}`);
    }

    // 가로는 HW_MIN으로 바닥 고정(두 도넛 통일), 세로는 라벨에 맞춰. 링 중심은 정중앙.
    const pad = 4;
    const dx = Math.max(cx - minX, maxX - cx, HW_MIN);
    const dy = Math.max(cy - minY, maxY - cy);
    const vbX = cx - dx - pad, vbY = cy - dy - pad;
    const vbW = 2 * (dx + pad), vbH = 2 * (dy + pad);
    return `<svg viewBox="${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" role="img">
      <g transform="rotate(-90 ${cx} ${cy})">${segs.join('')}</g>
      <text x="${cx}" y="${cy + 8}" text-anchor="middle" font-size="54" font-weight="700" fill="var(--ink)">${esc(centerValue)}</text>
      <text x="${cx}" y="${cy + 32}" text-anchor="middle" font-size="20" fill="var(--muted)">${esc(centerLabel)}</text>
      ${labels.join('')}
    </svg>`;
  }

  const R = 56;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const segs = parts
    .map((p) => {
      const off = acc / total;
      acc += p.value;
      const len = (p.value / total) * C;
      if (len < 0.8) return '';
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

// 홈 '점수 여정' 추이선: 분석할 때마다 남은 평균 점수를 시간순(왼→오)으로 잇는다.
// 클로드·코덱스를 각자 색으로 따로 잇는다(노드·간선 색 = 도구 색). x축은 두 도구가 공유하는 날짜축.
// y축은 0~100 전체가 아니라 점수 주변으로 줌인하되(작은 변화도 보이게), 좌측에 상·중·하 눈금값을 적어 솔직하게.
function journeySVG(pts: { date: string; score: number; source: 'claude' | 'codex' }[], selectedIdx: number): string {
  const n = pts.length;
  if (n < 2) return '';
  const W = 724;
  const H = 100;
  const padL = 30;
  const padR = 34;
  const padT = 12;
  const padB = 18;

  // 날짜의 합집합을 균등 간격으로 둔다(기존 룩 유지). 각 도구는 자기 날짜 위치에만 점을 찍는다.
  const allDates = [...new Set(pts.map((p) => p.date))].sort();
  const dn = allDates.length;
  const dateIdx = new Map(allDates.map((d, i) => [d, i]));
  const x = (di: number): number =>
    dn <= 1 ? padL + (W - padL - padR) / 2 : padL + (di / (dn - 1)) * (W - padL - padR);

  const scores = pts.map((p) => p.score);
  let lo = Math.max(0, Math.floor((Math.min(...scores) - 8) / 10) * 10);
  let hi = Math.min(100, Math.ceil((Math.max(...scores) + 8) / 10) * 10);
  if (hi - lo < 30) {
    hi = Math.min(100, lo + 30);
    if (hi - lo < 30) lo = Math.max(0, hi - 30);
  }
  const span = hi - lo || 1;
  const y = (s: number): number => padT + (1 - (s - lo) / span) * (H - padT - padB);

  const mid = Math.round((lo + hi) / 2);
  const grid = [hi, mid, lo]
    .map((v) => {
      const gy = y(v);
      return `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"/>` +
        `<text x="${(padL - 7).toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--muted)">${v}</text>`;
    })
    .join('');

  // 도구별 간선: 그 도구 점들만 날짜순으로 잇는다(점이 1개뿐이면 선 없이 점만)
  const lines = (['claude', 'codex'] as const)
    .map((src) => {
      const sp = pts.filter((p) => p.source === src).sort((a, b) => a.date.localeCompare(b.date));
      if (sp.length < 2) return '';
      const lp = sp.map((p) => `${x(dateIdx.get(p.date)!).toFixed(1)},${y(p.score).toFixed(1)}`);
      return `<polyline points="${lp.join(' ')}" fill="none" stroke="${SOURCE_COLOR[src]}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join('');

  // 점: 도구 색으로. 선택된 점만 채워서 강조한다(누르면 그 날짜 세부 점수가 위 칸에 뜬다). data-idx로 클릭을 잡는다.
  const dots = pts
    .map((p, i) => {
      const cx = x(dateIdx.get(p.date)!).toFixed(1);
      const cy = y(p.score).toFixed(1);
      const col = SOURCE_COLOR[p.source];
      const sel = i === selectedIdx;
      const r = sel ? 5.6 : 3.4;
      const ring = sel
        ? `<circle cx="${cx}" cy="${cy}" r="9" fill="none" stroke="${col}" stroke-width="1.4" opacity="0.28"/>`
        : '';
      return ring +
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${sel ? col : '#fff'}" stroke="${col}" stroke-width="2"/>` +
        `<circle class="jr-hit" data-idx="${i}" cx="${cx}" cy="${cy}" r="12" fill="transparent"><title>${SOURCE_LABEL[p.source]} · ${esc(p.date)} · ${p.score}점</title></circle>`;
    })
    .join('');

  const md = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const selDate = pts[selectedIdx]?.date;
  // 각 날짜 밑에 라벨. 날짜가 많아 겹칠 땐 간격이 충분한 것만 남긴다(처음·끝·선택날짜는 항상 표시).
  let lastLabelX = -Infinity;
  const dateLabels = allDates
    .map((d, i) => {
      const cx = x(i);
      const sel = d === selDate;
      const must = i === 0 || i === dn - 1 || sel;
      if (!must && cx - lastLabelX < 30) return '';
      lastLabelX = cx;
      const anchor = i === 0 ? 'start' : i === dn - 1 ? 'end' : 'middle';
      return `<text x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="${anchor}" font-size="9.5" font-weight="${sel ? 700 : 400}" fill="${sel ? 'var(--ink)' : 'var(--muted)'}">${esc(md(d))}</text>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">
    ${grid}
    ${lines}${dots}${dateLabels}
  </svg>`;
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

async function analyze(source: 'claude' | 'codex' = 'claude'): Promise<void> {
  if (running) return;
  // 클로드 분석만 점수를 서버(전체 순위)에 올린다. 아직 동의 여부를 묻지 않았다면
  // 업로드 전에 동의 모달을 먼저 띄운다(동의/거절과 무관하게 분석은 이어서 진행).
  if (source === 'claude' && rankConsent === 'unset') await askRankConsent();
  running = true;
  currentSource = source;
  $('report').classList.add('hidden');
  $('onboarding').classList.add('hidden');
  $('home').classList.add('hidden');
  $('progress').classList.remove('hidden');
  $('subtitle').classList.remove('hidden');
  $('subtitle').textContent = source === 'codex' ? '최근 Codex 기록을 읽는 중…' : '최근 30일 기록을 읽는 중…';
  try {
    const report = source === 'codex' ? await window.api.analyzeCodex(90) : await window.api.analyze(30);
    if ('status' in report) {
      // MAS 빌드: ~/.claude 접근이 아직 허용 안 됨 → 폴더 허용 받고 자동 재시도
      $('progress').classList.add('hidden');
      $('subtitle').textContent = '폴더 접근 허용이 필요해요';
      openAccessModal();
      return;
    }
    $('progress').classList.add('hidden');
    render(report);
    void loadHistory(); // 방금 저장된 스냅샷이 이전 결과·추이선에 바로 보이게 (클로드·코덱스 모두)
  } catch (e) {
    // 진행 영역을 그대로 두고 에러를 보여준다. 여기서 숨기면 실패가 무반응처럼 보인다
    ($('bar-fill') as HTMLElement).style.width = '0%';
    $('progress-label').textContent = '분석 실패: ' + String(e);
    $('subtitle').textContent = '분석에 실패했어요';
  } finally {
    running = false;
  }
}

function render(r: UsageReport, snapshotDate?: string): void {
  modalReport = r;
  currentReportDate = snapshotDate ?? r.generatedAt.slice(0, 10);
  if (r.sessions === 0) {
    renderOnboarding(r);
    return;
  }
  $('onboarding').classList.add('hidden');
  $('home').classList.add('hidden');
  $('doc-actions').classList.remove('hidden');
  // 제목 밑에 한 줄 설명(왼쪽이 허전하지 않게), 분석일·세션은 오른쪽에 두 줄로
  $('subtitle').classList.remove('hidden');
  $('subtitle').textContent = currentSource === 'codex' ? 'Codex 사용 습관 진단' : 'Claude Code 사용 습관 진단';
  const sessN = r.sessions.toLocaleString();
  $('report-meta').innerHTML = snapshotDate
    ? `<span>${snapshotDate} 저장본</span><span>세션 ${sessN}개</span>`
    : `<span>분석일 ${r.generatedAt.slice(0, 10)}</span><span>세션 ${sessN}개(최근 ${r.days}일)</span>`;

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

  $('meta').textContent =
    `파일 ${r.files}개 · 건너뛴 라인 ${r.skippedLines.toLocaleString()}개 · ` +
    `예상 사용 비용 ${fmtUSD(r.estCostUSD)} (API 환산 참고치) · 데이터는 내 컴퓨터의 ${currentSource === 'codex' ? '~/.codex/sessions' : '~/.claude/projects'}에서만 읽었어요`;

  $('report').classList.remove('hidden');
}

function renderOnboarding(r: UsageReport): void {
  currentReportDate = null;
  $('report').classList.add('hidden');
  $('home').classList.add('hidden');
  $('doc-actions').classList.remove('hidden');
  $('report-meta').textContent = '';
  $('subtitle').classList.remove('hidden');
  $('subtitle').textContent = '분석할 기록이 없어요';
  const steps = $('onboarding-steps');
  if (currentSource === 'codex') {
    steps.innerHTML = [
      `<li>Codex(OpenAI) 사용 기록이 <code>~/.codex/sessions</code>에 아직 없어요</li>`,
      `<li>Codex Desktop이나 CLI로 작업을 해보세요</li>`,
      `<li><code>AGENTS.md</code>에 프로젝트 규칙·명령·검증 절차를 적어두면 좋아요</li>`,
      `<li>며칠 쓰고 다시 코덱스 분석하기를 눌러보세요</li>`,
    ].join('');
    $('onboarding').classList.remove('hidden');
    return;
  }
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
  const avg = Math.round(r.scores.reduce((a, s) => a + s.score, 0) / Math.max(1, r.scores.length));
  const rank = r.rank;

  // 리포트(종합판정)는 등수 + 상위%만 (엠블럼·티어명은 랭킹 화면 전용 → 분석 리포트의 오피셜 톤 유지)
  if (rank && rank.percentile != null) {
    const myRank = Math.max(1, rank.total - rank.below);
    const topPct = Math.max(0, (1 - rank.percentile) * 100);
    const topTxt = topPct < 0.1 ? '0' : topPct < 1 ? topPct.toFixed(1) : String(Math.round(topPct));
    $('level').innerHTML =
      `${rank.total.toLocaleString()}명 중 ${myRank.toLocaleString()}위 · 상위 ${topTxt}% ` +
      `<span class="lv-desc">· 평균 ${avg}점</span>`;
    return;
  }

  // 순위를 못 받았을 때(오프라인 등)만 절대평가 Lv. 로 폴백
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
  $('level').innerHTML = `${esc(lv)} <span class="lv-desc">${esc(desc)} · 평균 ${avg}점</span>`;
}

// 티어 엠블럼: 9분할 PNG (emblems/<key>.png). 9장 모두 동일 캔버스·방패 바닥정렬, 챌린저만 왕관이 위로.
function emblemImg(key: string, cls = 'emblem'): string {
  return `<img class="${cls}" src="emblems/${esc(key)}.png" alt="" draggable="false" />`;
}

function renderAxes(r: UsageReport): void {
  $('radar').innerHTML = radarSVG(r.scores);
  // 점수는 왼쪽, 오른쪽엔 '세부 보기' 버튼 → 누르면 실제 수치를 팝업으로 (인라인으로 펼치면 아래 내용이 밀려서)
  // 구버전 스냅샷엔 metrics/detail이 없어 버튼 대신 빈 칸을 둬 그리드 정렬만 맞춘다. data-idx로 modalReport에서 조회
  $('axes').innerHTML = r.scores
    .map((s, i) => {
      const hasDetail = (s.metrics && s.metrics.length) || s.detail;
      const btn = hasDetail
        ? `<button class="axis-detail-btn" data-idx="${i}">상세 보기 <span class="arrow">›</span></button>`
        : '<span class="axis-detail-spacer"></span>';
      return `
    <div class="axis-item">
      <div class="axis-row">
        <span class="name">${esc(s.axis)}</span>
        <div class="track"><div class="fill" style="width:${s.score}%"></div></div>
        <span class="val">${s.score}점</span>
        ${btn}
      </div>
      ${s.desc ? `<div class="axis-sub">${esc(s.desc)}</div>` : ''}
    </div>`;
    })
    .join('');
}

// 한 축의 세부 수치 팝업: 라벨(왼쪽, 채점 힌트 포함) + 값(오른쪽 정렬). 구버전 스냅샷은 detail 문자열로 폴백
function openAxisModal(idx: number): void {
  const s = modalReport?.scores[idx];
  if (!s) return;
  $('axis-modal-title').textContent = s.axis;
  const rows =
    s.metrics && s.metrics.length
      ? s.metrics
          .map(
            (m) =>
              `<li><div class="amx-l"><span class="amx-label">${esc(m.label)}</span>${m.hint ? `<span class="amx-hint">${esc(m.hint)}</span>` : ''}</div><span class="amx-val">${esc(m.value)}</span></li>`
          )
          .join('')
      : (s.detail ?? '')
          .split(' · ')
          .filter(Boolean)
          .map((seg) => `<li><div class="amx-l"><span class="amx-label">${esc(seg)}</span></div></li>`)
          .join('');
  const criteriaHint = !$('btn-criteria').classList.contains('hidden')
    ? '<p class="footnote">점수가 어떻게 계산되는지는 <b>1. 종합 판정</b> 옆 <b>!</b> 버튼에서 볼 수 있어요.</p>'
    : '';
  $('axis-modal-body').innerHTML = `
    <div class="axis-modal-top">
      <span class="axis-modal-score">${s.score}<span class="axis-modal-unit">점</span></span>
      ${s.desc ? `<p class="axis-modal-desc">${esc(s.desc)}</p>` : ''}
    </div>
    <ul class="axis-modal-list">${rows}</ul>
    ${criteriaHint}`;
  $('axis-modal').classList.remove('hidden');
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
  // 가점(+)은 왼쪽, 감점(−)은 오른쪽 2열로. 근거는 설명 없이 출처 링크만(리다이렉트)
  const col = (items: string[]): string =>
    items.length
      ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : '<p class="crit-col-empty">없음</p>';
  $('criteria-body').innerHTML = crits
    .map((c) => {
      const src =
        c.sources && c.sources.length
          ? `<p class="crit-src"><span class="crit-src-h">근거</span>${c.sources
              .map(
                (s) =>
                  `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>`
              )
              .join('<span class="crit-src-sep">·</span>')}</p>`
          : '';
      return `
    <div class="crit">
      <p class="crit-axis">${esc(c.axis)}<span class="crit-what">${esc(c.what)}</span></p>
      <div class="crit-cols">
        <div class="crit-col crit-col-gain">
          <span class="crit-col-h crit-col-h-gain">+ 올려주는 것</span>
          ${col(c.gains)}
        </div>
        <div class="crit-col crit-col-pen">
          <span class="crit-col-h crit-col-h-pen">− 내리는 것</span>
          ${col(c.penalties)}
        </div>
      </div>
      ${src}
    </div>`;
    })
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
    '세션',
    true
  );
  $('categories').innerHTML = r.categories
    .map(
      (c, i) => `
    <div class="leg-row">
      <div class="leg-head">
        <span class="dot" style="background:${colorFor(c.name, i)}"></span>
        <span class="leg-name">${esc(c.name)}</span>
        <span class="leg-val">${c.pct}%(${c.sessions}회)</span>
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
          const rest = t.sessions - subs.reduce((a, p) => a + p.sessions, 0);
          const lis = subs
            .map(
              (p) =>
                `<li><span class="pp-name">${esc(p.name)}</span><span class="pp-val">${p.sessions}번</span></li>`
            )
            .join('');
          const restLi =
            rest > 0
              ? `<li class="pp-rest"><span class="pp-name">그 외</span><span class="pp-val">${rest}번</span></li>`
              : '';
          const projects = subs.length ? `<ul class="ptype-projects">${lis}${restLi}</ul>` : '';
          return `
      <div class="ptype-item${subs.length ? ' has-projects' : ''}">
        <div class="ptype-row">
          <span class="ptype-name">${esc(t.label)}</span>
          <span class="ptype-val">${t.sessions}회(${t.pct}%)${subs.length ? ` <span class="ptype-toggle">상세 보기 <span class="arrow">▾</span></span>` : ''}</span>
        </div>
        ${projects}
      </div>`;
        })
        .join('');
  } else {
    ptEl.classList.add('hidden');
  }
}

const ACT_DESC: Record<string, string> = {
  '대화·설계': '도구 없이 텍스트로만 응답',
  '명령 실행': '셸 명령 실행',
  '코드 읽기·검수': '읽기·검색만, 수정 없음',
  '서버·스크립트 코드': '백엔드·로직 파일 수정',
  '프론트 코드': 'UI·화면 파일 수정',
  '문서·설정 파일': '문서·설정 파일 수정',
  '컴퓨터·브라우저 제어': '마우스·키보드로 직접 제어',
  '기타 도구': '스킬·에이전트 등',
};

// 구버전 저장본에는 activities/inventory가 없을 수 있어 블록 단위로 숨긴다
function renderActivities(r: UsageReport): void {
  const actBlock = $('activities-block');
  if (!r.activities || r.activities.length === 0) {
    actBlock.classList.add('hidden');
    return;
  }
  actBlock.classList.remove('hidden');
  const actTotal = r.activities.reduce((a, x) => a + x.total, 0);
  $('act-donut').innerHTML = donutSVG(
    r.activities.map((a, i) => ({
      name: a.name,
      value: a.total,
      color: colorFor(a.name, i),
      tip: `${a.name} ${a.pct}% (${fmtTokens(a.total)} 토큰)`,
    })),
    fmtTokens(actTotal),
    '토큰',
    true
  );
  $('activities').innerHTML = r.activities
    .map((a, i) => {
      const desc = ACT_DESC[a.name] ?? '';
      const sub = desc ? `<p class="leg-sub">${esc(desc)}</p>` : '';
      return `
    <div class="leg-row" title="메시지 ${a.msgs.toLocaleString()}개 · 출력 토큰 ${fmtTokens(a.output)}">
      <div class="leg-head">
        <span class="dot" style="background:${colorFor(a.name, i)}"></span>
        <span class="leg-name">${esc(a.name)}</span>
        <span class="leg-val">${a.pct}%(${fmtTokens(a.total)})</span>
      </div>
      ${sub}
    </div>`;
    })
    .join('');
}

function renderInventory(r: UsageReport): void {
  const card = $('inventory-card');
  if (!r.inventory) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const inv = r.inventory;
  $('inv-claudemd-title').textContent = currentSource === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  const kb = (b: number): string => (b >= 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B');
  // 리스트가 길면 5개만 보이고 나머지는 '⋯ N개 더'로 접는다(클릭하면 펼침)
  const capped = (rows: string[], cap = 5): string => {
    if (rows.length <= cap) return rows.join('');
    const n = rows.length - cap;
    return (
      rows.slice(0, cap).join('') +
      `<div class="inv-extra hidden">${rows.slice(cap).join('')}</div>` +
      `<button class="inv-more" type="button"><span class="more-show">⋯ ${n}개 더</span><span class="more-hide">접기</span> <span class="arrow">▾</span></button>`
    );
  };

  // CLAUDE.md: 바탕화면·홈에서 훑어 '있는 곳'만 보여준다. 상위 폴더 상속분(woowa_course 등)은 출처를 덧붙인다.
  const mdScanned = [
    { name: currentSource === 'codex' ? '전역 ~/.codex' : '전역 ~/.claude', has: inv.globalClaudeMd.exists, bytes: inv.globalClaudeMd.bytes, note: '' },
    ...inv.projectClaudeMds.map((p) => ({
      name: p.project,
      has: p.has,
      bytes: p.bytes,
      note: p.has && p.foundAt && p.foundAt !== p.cwd ? `${p.foundAt.split('/').filter(Boolean).pop() ?? ''}/ 상속` : '',
    })),
  ];
  // 있는 곳(파랑)을 위로, 없는 곳은 흐리게 아래로 — '어디 더 두면 좋은지'까지 한 카드에서 보이게
  const mdHave = mdScanned.filter((m) => m.has);
  const mdMiss = mdScanned.filter((m) => !m.has);
  const mdRow = (m: (typeof mdScanned)[number]): string =>
    m.has
      ? `<div class="inv-row"${m.note ? ` title="${esc(m.note)}"` : ''}>
        <span class="st on"></span>
        <span class="inv-name">${esc(m.name)}${m.note ? ` <span class="inv-note">${esc(m.note)}</span>` : ''}</span>
        <span class="inv-val ok">${esc(kb(m.bytes))}</span>
      </div>`
      : `<div class="inv-row">
        <span class="st off"></span>
        <span class="inv-name dim-name">${esc(m.name)}</span>
        <span class="inv-val dim">없음</span>
      </div>`;
  $('inv-claudemd').innerHTML =
    `<p class="inv-sum">${mdHave.length}/${mdScanned.length}곳에 있음 <span class="hint">바탕화면·홈 탐색</span></p>` +
    capped([...mdHave, ...mdMiss].map(mdRow)) +
    (mdHave.length ? '' : '<p class="hint">자주 쓰는 폴더에 두면 매번 설명을 안 해도 돼요</p>');

  // 스킬: 호출 횟수를 미니 막대로
  const usedSkills = inv.skills.filter((s) => s.uses > 0).length;
  const maxUses = Math.max(1, ...inv.skills.map((s) => s.uses));
  $('inv-skills').innerHTML = inv.skills.length
    ? `<p class="inv-sum">${inv.skills.length}개 중 ${usedSkills}개 호출됨</p>` +
      capped(
        inv.skills.map((s) => {
          const w = s.uses > 0 ? Math.max(6, Math.sqrt(s.uses / maxUses) * 100) : 0;
          return `
      <div class="inv-row" title="${esc(s.description)}">
        <span class="inv-name ${s.uses === 0 ? 'dim-name' : ''}">${esc(s.name)}</span>
        <div class="s-track">${w > 0 ? `<div class="s-fill" style="width:${w.toFixed(0)}%"></div>` : ''}</div>
        <span class="inv-val ${s.uses === 0 ? 'dim' : ''}">${s.uses}회</span>
      </div>`;
        })
      )
    : `<p class="hint">${currentSource === 'codex' ? '~/.codex/skills' : '~/.claude/skills'}에 스킬이 없어요</p>`;

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
  const adoptOf = (f: (typeof fc)[number]): number => f.adopt ?? (f.used ? 1 : 0);
  // 채택 단계로 묶어 '잘 쓰는 것 ↔ 안 쓰는 것'을 한눈에. 빈 그룹은 숨긴다.
  const tiers = [
    { key: 'on', label: '자주 사용', items: fc.filter((f) => adoptOf(f) >= 1) },
    { key: 'mid', label: '가끔 사용', items: fc.filter((f) => adoptOf(f) > 0 && adoptOf(f) < 1) },
    { key: 'off', label: '미사용', items: fc.filter((f) => adoptOf(f) <= 0) },
  ].filter((t) => t.items.length);
  const chip = (f: (typeof fc)[number], key: string): string =>
    `<span class="fc-chip ${key}">${esc(f.name)}${f.detail ? ` <span class="fc-n">${esc(f.detail)}</span>` : ''}</span>`;
  const bar = tiers
    .map((t) => `<div class="fc-seg ${t.key}" style="flex:${t.items.length}" title="${t.label} ${t.items.length}개"></div>`)
    .join('');
  const groups = tiers
    .map(
      (t) =>
        `<div class="fc-group"><div class="fc-glabel ${t.key}"><span class="fc-dot"></span>${t.label}<b>${t.items.length}</b></div>` +
        `<div class="fc-chips">${t.items.map((f) => chip(f, t.key)).join('')}</div></div>`
    )
    .join('');
  el.innerHTML =
    `<div class="fc-head"><span class="fc-title">공식 기능 활용</span></div>` +
    `<div class="fc-bar">${bar}</div>` +
    `<div class="fc-groups">${groups}</div>`;
}

// ---- 시작 페이지 + 이전 결과(스냅샷) ----

type SnapItem = Awaited<ReturnType<typeof window.api.history>>[number];

// 분석 결과 대신 시작 화면을 보여준다 (앱 첫 진입, 제목 클릭)
function showHome(): void {
  currentReportDate = null;
  $('report').classList.add('hidden');
  $('onboarding').classList.add('hidden');
  $('progress').classList.add('hidden');
  $('doc-actions').classList.add('hidden');
  $('home').classList.remove('hidden');
  $('subtitle').classList.remove('hidden');
  $('subtitle').textContent = '최근 사용 기록을 기반으로 AI 활용 패턴을 진단합니다.';
}

function currentPdfName(): string {
  const date = currentReportDate ?? new Date().toISOString().slice(0, 10);
  return `AI 리포트-${SOURCE_LABEL[currentSource]}-${date}.pdf`.normalize('NFC');
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function measurePdfLayout(): Promise<{ width: number; height: number }> {
  document.body.classList.add('pdf-exporting');
  await nextFrame();
  await nextFrame();

  const html = document.documentElement;
  const body = document.body;
  const width = Math.ceil(Math.max(html.scrollWidth, body.scrollWidth, window.innerWidth));

  return {
    width,
    height: Math.ceil(width * Math.SQRT2),
  };
}

async function saveCurrentReportPdf(): Promise<void> {
  if (savingPdf || !modalReport) return;
  const btn = $('btn-save-pdf') as HTMLButtonElement;
  const original = btn.textContent || 'PDF 저장';
  savingPdf = true;
  btn.disabled = true;
  btn.textContent = '저장 중...';

  let delay = 0;
  try {
    const layout = await measurePdfLayout();
    const res = await window.api.saveReportPdf(currentPdfName(), layout);
    if (res.ok) {
      btn.textContent = '저장 완료';
      delay = 1300;
    } else if (res.canceled) {
      btn.textContent = original;
    } else {
      console.error('[pdf] save failed', res.error);
      btn.textContent = '저장 실패';
      delay = 1600;
    }
  } catch (e) {
    console.error('[pdf] save failed', e);
    btn.textContent = '저장 실패';
    delay = 1600;
  } finally {
    document.body.classList.remove('pdf-exporting');
    window.setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
      savingPdf = false;
    }, delay);
  }
}

// 랭킹 리더보드 팝업: 상위 5위 + (5위 밖이면) ⋯ + 내 행. 표 = 엠블럼·등수·평균·이름.
async function openRankModal(): Promise<void> {
  const body = $('rank-modal-body');
  body.innerHTML = '<p class="rank-empty">불러오는 중…</p>';
  $('rank-modal').classList.remove('hidden');
  try {
    const lb = await window.api.leaderboard();
    if (!lb || lb.total === 0) {
      body.innerHTML =
        '<p class="rank-empty">아직 랭킹에 오른 사람이 없어요.<br/><b>클로드 분석하기</b>로 분석하면 순위가 올라가요.</p>';
      return;
    }
    body.innerHTML = leaderboardHTML(lb);
  } catch {
    body.innerHTML = '<p class="rank-empty">랭킹을 불러오지 못했어요.<br/>잠시 후 다시 시도해주세요.</p>';
  }
}

function leaderboardRowHTML(r: LbRow): string {
  const emblem = r.tier ? emblemImg(r.tier.key, 'lb-emblem-img') : '';
  const you = r.isMe ? '<span class="lb-you">나</span>' : '';
  // 긴 닉네임은 7자에서 …로 줄여 칸 너비를 고정(점수 가운데·레이아웃 유지). 전체 이름은 마우스 오버 툴팁으로.
  const chars = [...r.name];
  const nameHtml =
    chars.length > 7
      ? `<span title="${esc(r.name)}">${esc(chars.slice(0, 7).join(''))}…</span>`
      : esc(r.name);
  // 세부 보기는 내 행에만 — 축별 점수는 내 것만 로컬에 있다(서버 리더보드는 평균만 준다)
  const action = r.isMe
    ? '<button class="lb-detail-btn" type="button">상세 보기 <span class="arrow">›</span></button>'
    : '';
  return (
    `<tr class="lb-row${r.isMe ? ' lb-me' : ''}">` +
    `<td class="lb-c-emblem">${emblem}</td>` +
    `<td class="lb-c-rnk">${r.rnk}위</td>` +
    `<td class="lb-c-avg">${r.avg}<span class="lb-unit">점</span></td>` +
    `<td class="lb-c-name">${nameHtml}${you}</td>` +
    `<td class="lb-c-action">${action}</td>` +
    `</tr>`
  );
}

function leaderboardHTML(lb: Leaderboard): string {
  const rows = lb.top.map(leaderboardRowHTML).join('');
  // 내가 상위 목록 안에 없고 내 행이 있으면 ⋯ 구분선 + 내 행을 맨 아래 덧붙인다
  const meInTop = lb.top.some((r) => r.isMe);
  const tail =
    lb.me && !meInTop ? `<tr class="lb-gap"><td colspan="5">⋯</td></tr>${leaderboardRowHTML(lb.me)}` : '';
  const cap = lb.me
    ? `<p class="lb-cap">전체 <b>${lb.total.toLocaleString()}명</b> 중 <b>${lb.me.rnk.toLocaleString()}위</b></p>`
    : `<p class="lb-cap">전체 <b>${lb.total.toLocaleString()}명</b></p>`;
  const note = !lb.me ? '<p class="lb-note">분석하면 내 순위도 여기 올라가요.</p>' : '';
  return `${cap}<table class="lb"><tbody>${rows}${tail}</tbody></table>${note}`;
}

// 내 축별 점수: 최신 클로드 저장본을 쓴다(랭킹은 클로드 점수 기준). 없으면 이번 세션 분석본으로 폴백.
async function loadMyScores(): Promise<{ axis: string; score: number }[] | null> {
  try {
    const items = await window.api.history();
    const latestClaude = items.find((it) => it.source === 'claude');
    if (latestClaude) {
      const r = await window.api.snapshot(latestClaude.date, 'claude');
      if (r?.scores?.length) return r.scores.map((s) => ({ axis: s.axis, score: s.score }));
    }
  } catch {
    // 저장본 조회 실패는 치명적이지 않다 — modalReport 로 폴백
  }
  return modalReport?.scores?.length
    ? modalReport.scores.map((s) => ({ axis: s.axis, score: s.score }))
    : null;
}

// 내 점수 세부 팝업: 평균이 어떤 축 점수들로 이뤄졌는지 간단히 (랭킹 → 세부 보기)
async function openScoreDetail(): Promise<void> {
  const body = $('score-detail-body');
  body.innerHTML = '<p class="rank-empty">불러오는 중…</p>';
  $('score-detail-modal').classList.remove('hidden');
  const scores = await loadMyScores();
  if (!scores || !scores.length) {
    body.innerHTML =
      '<p class="rank-empty">아직 점수가 없어요.<br/><b>클로드 분석하기</b>로 분석하면 보여요.</p>';
    return;
  }
  const avg = Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length);
  const rows = scores
    .map(
      (s) => `
    <li>
      <span class="sd-axis">${esc(s.axis)}</span>
      <div class="sd-track"><div class="sd-fill" style="width:${s.score}%"></div></div>
      <span class="sd-val">${s.score}<span class="sd-unit">점</span></span>
    </li>`
    )
    .join('');
  body.innerHTML =
    `<div class="sd-top"><span class="sd-avg">${avg}<span class="sd-avg-unit">점</span></span></div>` +
    `<ul class="sd-list">${rows}</ul>`;
}

// ── 닉네임(공개 랭킹 표시명) ───────────────────────────────────────
let myNick = '';
let nickFirstRun = false;

// ── 전체 순위 업로드 동의 ──────────────────────────────────────────
// App Store 5.1.2(i): 점수를 서버(전체 순위)에 올리기 전에 명시적 동의를 받는다.
// 'unset'이면 첫 클로드 분석 직전에 동의 모달을 띄워 사용자가 직접 선택하게 한다.
let rankConsent: 'yes' | 'no' | 'unset' = 'unset';
let consentResolve: ((agree: boolean) => void) | null = null;

// 동의 모달을 띄우고, 사용자가 버튼을 누를 때까지 기다린다(동의/거절 모두 분석은 진행).
function askRankConsent(): Promise<boolean> {
  const input = $('consent-nick') as HTMLInputElement;
  input.value = myNick;
  $('consent-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 30);
  return new Promise((resolve) => {
    consentResolve = resolve;
  });
}

// 동의/거절 확정: 서버 동의 플래그를 저장하고, 동의면 닉네임도 함께 저장한다.
async function decideRankConsent(agree: boolean): Promise<void> {
  rankConsent = await window.api.setRankConsent(agree);
  if (agree) {
    const input = $('consent-nick') as HTMLInputElement;
    myNick = await window.api.setNickname(input.value.trim().slice(0, 24));
    updateNickChip();
  }
  $('consent-modal').classList.add('hidden');
  const r = consentResolve;
  consentResolve = null;
  if (r) r(agree);
}

// 보고서 우상단 칩에 현재 닉네임을 반영 (없으면 '닉네임 설정' 안내)
function updateNickChip(): void {
  const chip = $('nick-chip');
  chip.textContent = myNick ? myNick : '닉네임 설정';
  chip.classList.toggle('nick-chip-empty', !myNick);
}

// 닉네임 입력 팝업. firstRun=true면 첫 실행 안내(건너뛰어도 빈 닉네임으로 확정해 다시 안 묻는다)
function openNickModal(firstRun: boolean): void {
  nickFirstRun = firstRun;
  const input = $('nick-input') as HTMLInputElement;
  input.value = myNick;
  $('btn-nick-skip').textContent = firstRun ? '나중에' : '취소';
  $('nick-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 30);
}

async function saveNick(): Promise<void> {
  const input = $('nick-input') as HTMLInputElement;
  myNick = await window.api.setNickname(input.value.trim().slice(0, 24));
  updateNickChip();
  $('nick-modal').classList.add('hidden');
}

// 저장 없이 닫기. 첫 실행이면 현재값(보통 빈 문자열)을 저장해 다음 실행 때 다시 안 묻는다.
function dismissNick(): void {
  if (nickFirstRun) void window.api.setNickname(myNick);
  $('nick-modal').classList.add('hidden');
}

// 앱 시작 시: 저장된 닉네임을 칩에 반영하고, 한 번도 안 정했으면 첫 실행 팝업을 띄운다
async function initNickname(): Promise<void> {
  try {
    const [n, consent] = await Promise.all([window.api.getNickname(), window.api.getRankConsent()]);
    myNick = n.name;
    rankConsent = consent;
    updateNickChip();
    // 시작 화면에서 닉네임을 먼저 묻지 않는다. 닉네임·동의는 첫 클로드 분석 직전 동의 모달에서 한 번에 받는다.
  } catch {
    // 닉네임·동의 조회 실패는 치명적이지 않다(분석은 그대로 동작)
  }
}

// ── 폴더 접근(App Store 샌드박스) ─────────────────────────────────
// MAS 빌드에서만 쓰인다. ~/.claude 접근을 한 번 허용받아 북마크로 저장한다.
// 허용되면 onGranted(온보딩에서는 닉네임 단계)를, 없으면 바로 분석을 재시도한다.
let accessAfter: (() => void) | null = null;
function openAccessModal(onGranted?: () => void): void {
  accessAfter = onGranted ?? null;
  $('access-modal').classList.remove('hidden');
}
async function chooseClaudeFolder(): Promise<void> {
  const res = await window.api.chooseClaudeDir();
  if (!res.ok) return; // 취소하면 모달을 그대로 둬 다시 선택할 수 있게 한다
  $('access-modal').classList.add('hidden');
  const after = accessAfter;
  accessAfter = null;
  if (after) after();
  else void analyze();
}

// 첫 실행: MAS 빌드이고 폴더 미허용이면 폴더 허용을 먼저 받고, 그 다음 닉네임으로 넘어간다.
async function initOnboarding(): Promise<void> {
  try {
    const acc = await window.api.claudeAccess();
    if (acc.isMas && !acc.hasAccess) {
      openAccessModal(() => void initNickname());
      return;
    }
  } catch {
    // 권한 조회 실패 시에도 닉네임 단계는 진행한다
  }
  void initNickname();
}

// 홈 '점수 여정': 분석할 때마다 남은 평균 점수를 시간순으로 잇는다(왼=처음). 점을 누르면 그날 세부 점수가 위에 뜬다.
// 리포트로 '들어가는' 건 아래 '이전 결과'가 담당 — 여기 점 클릭은 세부 점수 미리보기만 한다.
let journeyPts: { date: string; score: number; source: 'claude' | 'codex' }[] = [];
let journeySelected = -1;
// 캐시 키는 도구+날짜 (같은 날 클로드·코덱스 저장본이 따로 있을 수 있어서)
const journeyScoreCache = new Map<string, { axis: string; score: number }[]>();
const jrKey = (p: { date: string; source: 'claude' | 'codex' }): string => `${p.source}:${p.date}`;

function renderHomeJourney(items: SnapItem[]): void {
  const el = $('home-journey');
  if (!items.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    journeyPts = [];
    return;
  }
  el.classList.remove('hidden');
  // 날짜 오름차순(왼=처음). 같은 날이면 클로드를 먼저.
  journeyPts = items
    .map((it) => ({ date: it.date, score: it.avgScore, source: it.source }))
    .sort((a, b) =>
      a.date === b.date ? (a.source === b.source ? 0 : a.source === 'claude' ? -1 : 1) : a.date.localeCompare(b.date)
    );
  journeySelected = -1;

  // 가장 최근 점을 기본 선택(같은 날 둘 다면 클로드 우선)
  let last = journeyPts.length - 1;
  const lastDate = journeyPts[last]?.date;
  for (let i = 0; i < journeyPts.length; i++) {
    if (journeyPts[i].date === lastDate && journeyPts[i].source === 'claude') {
      last = i;
      break;
    }
  }

  // 클로드·코덱스가 둘 다 있을 때만 색 범례를 보여준다(한 도구뿐이면 군더더기)
  const hasBoth = journeyPts.some((p) => p.source === 'claude') && journeyPts.some((p) => p.source === 'codex');
  const legend = hasBoth
    ? `<div class="jr-legend">` +
      (['claude', 'codex'] as const)
        .map((s) => `<span class="jr-leg"><i style="background:${SOURCE_COLOR[s]}"></i>${SOURCE_LABEL[s]}</span>`)
        .join('') +
      `</div>`
    : '';

  // 분석 1번뿐이면 추이선 없이 그날 세부 점수만
  if (journeyPts.length < 2) {
    el.innerHTML = `
      <div class="jr-card">
        <div class="jr-head"><span class="jr-title">점수 추이</span><span class="jr-cap">1번 분석</span></div>
        <div id="jr-detail" class="jr-detail"></div>
        <p class="jr-note">두 번째 분석부터 변화 추이가 표시됩니다</p>
      </div>`;
    void selectJourneyNode(last);
    return;
  }

  const peak = Math.max(...journeyPts.map((p) => p.score));
  el.innerHTML = `
    <div class="jr-card">
      <div class="jr-head">
        <span class="jr-title">점수 추이 <span class="jr-hint">각 지점을 선택하면 해당 날짜의 세부 점수를 확인할 수 있습니다</span></span>
        <span class="jr-cap">${journeyPts.length}번 분석 · 최고 ${peak}점</span>
      </div>
      <div id="jr-detail" class="jr-detail"></div>
      <div id="jr-chart" class="jr-chart">${journeySVG(journeyPts, last)}</div>
      ${legend}
    </div>`;
  void selectJourneyNode(last); // 기본은 가장 최근 점
}

// 점 선택: 그 점을 강조하고, 그날 저장본의 축별 점수를 불러와 위 세부 칸에 그린다(한 번 부른 건 캐시).
async function selectJourneyNode(idx: number): Promise<void> {
  if (idx < 0 || idx >= journeyPts.length) return;
  journeySelected = idx;
  const chart = document.getElementById('jr-chart');
  if (chart) chart.innerHTML = journeySVG(journeyPts, idx);
  const detail = document.getElementById('jr-detail');
  if (!detail) return;
  const pt = journeyPts[idx];
  const { date, score: avg, source } = pt;
  const key = jrKey(pt);
  let scores = journeyScoreCache.get(key);
  if (!scores) {
    detail.classList.add('jr-d-loading');
    try {
      const r = await window.api.snapshot(date, source);
      scores = (r?.scores ?? []).map((s) => ({ axis: s.axis, score: s.score }));
    } catch {
      scores = [];
    }
    journeyScoreCache.set(key, scores);
    detail.classList.remove('jr-d-loading');
    if (journeySelected !== idx) return; // 그새 다른 점을 눌렀으면 덮어쓰지 않는다
  }
  renderJourneyDetail(detail, date, avg, scores, source);
}

// 세부 칸: 왼쪽에 그날 평균(크게) + 도구 배지, 오른쪽에 축별 세부지표(작게·게이지 없이 이름·점수만). 리포트의 종합판정 축과 같은 값.
function renderJourneyDetail(
  el: HTMLElement,
  date: string,
  avg: number,
  scores: { axis: string; score: number }[],
  source: 'claude' | 'codex'
): void {
  const left =
    `<div class="jr-d-avg">` +
    `<span class="jr-d-date">${esc(date)} <span class="snap-src ${source}">${SOURCE_LABEL[source]}</span></span>` +
    `<span class="jr-d-avg-row"><span class="jr-d-avg-num">${avg}</span><span class="jr-d-avg-unit">점</span></span>` +
    `<span class="jr-d-avg-cap">평균 점수</span>` +
    `</div>`;
  if (!scores.length) {
    el.innerHTML = `<div class="jr-d-row">${left}<p class="jr-d-empty">이 저장본에는 세부 점수가 없습니다</p></div>`;
    return;
  }
  const cells = scores
    .map(
      (s) =>
        `<span class="jr-d-ax"><span class="jr-d-ax-name">${esc(s.axis)}</span><b class="jr-d-ax-score">${s.score}</b></span>`
    )
    .join('');
  el.innerHTML = `<div class="jr-d-row">${left}<div class="jr-d-axes">${cells}</div></div>`;
}

// 이전 결과: 기본 3개만 보여주고 나머지는 '⋯ 더 보기'로 펼친다.
let historyItems: SnapItem[] = [];
let historyExpanded = false;
const HISTORY_COLLAPSED = 3;

function renderHomeHistory(items: SnapItem[]): void {
  historyItems = items;
  const wrap = $('home-history');
  if (!items.length) {
    wrap.innerHTML =
      '<p class="home-hist-empty">아직 발급된 리포트가 없습니다.<br/>위에서 분석을 실행하면 결과가 이곳에 기록됩니다.</p>';
    return;
  }
  const shown = historyExpanded ? items : items.slice(0, HISTORY_COLLAPSED);
  const head =
    `<div class="home-hist-head">` +
    `<span class="hh-src">도구</span>` +
    `<span class="hh-date">분석일</span>` +
    `<span class="hh-avg">평균</span>` +
    `<span class="hh-sess">세션</span>` +
    `<span class="hh-tok">토큰</span>` +
    `</div>`;
  const rows = shown
    .map(
      (it) => `
      <button class="home-snap" data-date="${esc(it.date)}" data-source="${it.source}">
        <span class="snap-src ${it.source}">${SOURCE_LABEL[it.source]}</span>
        <span class="home-snap-date">${esc(it.date)}</span>
        <span class="home-snap-avg">${it.avgScore}<span class="hs-unit">점</span></span>
        <span class="home-snap-sess">${it.sessions.toLocaleString()}<span class="hs-unit">개</span></span>
        <span class="home-snap-tok">${esc(fmtTokens(it.totalTokens))}</span>
      </button>`
    )
    .join('');
  const rest = items.length - HISTORY_COLLAPSED;
  const more =
    !historyExpanded && rest > 0
      ? `<button class="home-more" id="home-more">⋯ ${rest}개 더 보기</button>`
      : '';
  wrap.innerHTML = head + rows + more;
}

async function loadHistory(): Promise<void> {
  try {
    const items = await window.api.history();
    renderHomeJourney(items);
    renderHomeHistory(items);
  } catch {
    // 목록 실패는 치명적이지 않다
  }
}

async function viewSnapshot(date: string, source: 'claude' | 'codex' = 'claude'): Promise<void> {
  const r = await window.api.snapshot(date, source);
  if (!r) return;
  currentSource = source;
  render(r, date);
}

$('btn-home-analyze').addEventListener('click', () => void analyze('claude'));
$('btn-home-codex').addEventListener('click', () => void analyze('codex'));
$('btn-home-ranking').addEventListener('click', () => void openRankModal());
$('app-title').addEventListener('click', () => showHome());
$('btn-save-pdf').addEventListener('click', () => void saveCurrentReportPdf());
$('btn-back-home').addEventListener('click', () => showHome());
// 시작 화면의 이전 결과: '⋯ 더 보기'면 펼치고, 카드면 그 저장본 열기
$('home-history').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.home-more')) {
    historyExpanded = true;
    renderHomeHistory(historyItems);
    return;
  }
  const card = (e.target as HTMLElement).closest('.home-snap') as HTMLElement | null;
  if (card?.dataset.date) void viewSnapshot(card.dataset.date, (card.dataset.source as 'claude' | 'codex') ?? 'claude');
});
// 점수 여정 추이선의 점 클릭 → 그날 세부 점수만 위에 표시(리포트로 들어가는 건 아래 '이전 결과'가 담당)
$('home-journey').addEventListener('click', (e) => {
  const hit = (e.target as Element).closest('.jr-hit');
  if (!hit) return;
  const idx = Number(hit.getAttribute('data-idx'));
  if (!Number.isNaN(idx)) void selectJourneyNode(idx);
});
// 축의 '세부 보기' 버튼 → 세부 수치 팝업
$('axes').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.axis-detail-btn') as HTMLElement | null;
  if (btn?.dataset.idx) openAxisModal(Number(btn.dataset.idx));
});
// 프로젝트 종류: 항목 클릭 → 하위 프로젝트 목록 펼치기/접기
$('project-types').addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest('.ptype-item.has-projects') as HTMLElement | null;
  if (item) item.classList.toggle('show-projects');
});
// 설정 자산 카드(CLAUDE.md·스킬): '⋯ N개 더' → 5개 초과분 펼치기/접기
for (const id of ['inv-claudemd', 'inv-skills']) {
  $(id).addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.inv-more') as HTMLElement | null;
    if (!btn) return;
    const extra = btn.previousElementSibling as HTMLElement | null;
    if (extra) extra.classList.toggle('hidden');
    btn.classList.toggle('open');
  });
}
// (작업 의도별 세션은 하위 프로젝트를 펼치지 않는다 — '프로젝트 종류'로 대체)
$('btn-criteria').addEventListener('click', () => $('criteria-modal').classList.remove('hidden'));
$('btn-criteria-close').addEventListener('click', () => $('criteria-modal').classList.add('hidden'));
$('criteria-modal').addEventListener('click', (e) => {
  if (e.target === $('criteria-modal')) $('criteria-modal').classList.add('hidden');
});
$('btn-axis-close').addEventListener('click', () => $('axis-modal').classList.add('hidden'));
$('axis-modal').addEventListener('click', (e) => {
  if (e.target === $('axis-modal')) $('axis-modal').classList.add('hidden');
});
$('btn-rank-close').addEventListener('click', () => $('rank-modal').classList.add('hidden'));
$('rank-modal').addEventListener('click', (e) => {
  // 내 행의 '세부 보기' → 축별 점수 팝업 (리더보드는 매번 다시 그려져 위임으로 잡는다)
  if ((e.target as HTMLElement).closest('.lb-detail-btn')) {
    void openScoreDetail();
    return;
  }
  if (e.target === $('rank-modal')) $('rank-modal').classList.add('hidden');
});
$('btn-score-detail-close').addEventListener('click', () => $('score-detail-modal').classList.add('hidden'));
$('score-detail-modal').addEventListener('click', (e) => {
  if (e.target === $('score-detail-modal')) $('score-detail-modal').classList.add('hidden');
});
// 닉네임 칩 클릭: 이미 순위에 참여 중이면 닉네임 수정, 아직 동의 안 했으면 참여(동의) 모달.
$('nick-chip').addEventListener('click', () => void onNickChipClick());
$('btn-nick-save').addEventListener('click', () => void saveNick());
$('btn-nick-skip').addEventListener('click', () => dismissNick());
$('btn-nick-close').addEventListener('click', () => dismissNick());
$('btn-access-choose').addEventListener('click', () => void chooseClaudeFolder());
$('nick-modal').addEventListener('click', (e) => {
  if (e.target === $('nick-modal')) dismissNick();
});
// 전체 순위 동의 모달: 동의하고 참여 / 참여 안 함 / 배경 클릭(=거절). 분석은 어느 쪽이든 진행된다.
$('btn-consent-agree').addEventListener('click', () => void decideRankConsent(true));
$('btn-consent-decline').addEventListener('click', () => void decideRankConsent(false));
$('consent-modal').addEventListener('click', (e) => {
  if (e.target === $('consent-modal')) void decideRankConsent(false);
});
$('consent-nick').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void decideRankConsent(true);
});

// 칩 클릭 처리: 참여 중이면 닉네임 수정, 아니면 동의 모달을 띄우고 동의 시 직전 분석 결과를 바로 순위에 반영한다.
async function onNickChipClick(): Promise<void> {
  if (rankConsent === 'yes') {
    openNickModal(false);
    return;
  }
  const agreed = await askRankConsent();
  if (!agreed) return;
  const rank = await window.api.submitCurrent();
  if (rank && modalReport) {
    modalReport.rank = rank;
    renderLevel(modalReport);
  }
}
$('nick-input').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void saveNick();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 세부 팝업이 떠 있으면 그것만 닫는다 (랭킹은 뒤에 그대로 둔다)
  if (!$('score-detail-modal').classList.contains('hidden')) {
    $('score-detail-modal').classList.add('hidden');
    return;
  }
  // 동의 모달이 떠 있으면 Esc 는 '참여 안 함'(거절)으로 닫는다(분석은 이어서 진행).
  if (!$('consent-modal').classList.contains('hidden')) {
    void decideRankConsent(false);
    return;
  }
  $('criteria-modal').classList.add('hidden');
  $('axis-modal').classList.add('hidden');
  $('rank-modal').classList.add('hidden');
  if (!$('nick-modal').classList.contains('hidden')) dismissNick();
});

// 앱을 열면 시작 화면을 보여준다 (분석은 사용자가 직접 시작)
void loadHistory();
void initOnboarding();
showHome();
