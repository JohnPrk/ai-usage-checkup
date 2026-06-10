import * as fs from 'fs';
import * as readline from 'readline';
import { SessionSummary } from './types';
import { ScannedFile } from './scanner';

// 이미지 base64 등 비정상적으로 큰 라인은 통째로 건너뛴다 (usage가 들어있지 않은 라인들)
const MAX_LINE_LENGTH = 1_000_000;

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

// 한 메시지(id 기준)의 도구·파일 확장자를 라인들에 걸쳐 모은다
interface MsgMeta {
  tools: string[];
  exts: string[];
  output: number;
  total: number;
}

const FRONT_EXTS = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'tsx', 'jsx', 'vue', 'svelte']);
const CODE_EXTS = new Set([
  'java', 'kt', 'kts', 'py', 'ts', 'js', 'mjs', 'cjs', 'sql', 'go', 'rs', 'rb',
  'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'zsh', 'bash',
]);
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);

function classifyActivity(tools: string[], exts: string[]): string {
  if (tools.length === 0) return '대화·설계';
  if (tools.some((t) => /^mcp__(computer-use|claude[-_]in[-_]chrome|Claude_in_Chrome|Claude_Preview)/i.test(t))) {
    return '컴퓨터·브라우저 제어';
  }
  if (exts.length > 0) {
    let front = 0;
    let code = 0;
    let doc = 0;
    for (const e of exts) {
      if (FRONT_EXTS.has(e)) front++;
      else if (CODE_EXTS.has(e)) code++;
      else doc++;
    }
    if (front > 0 && front >= code && front >= doc) return '프론트 코드';
    if (code > 0 && code >= doc) return '서버·스크립트 코드';
    return '문서·설정 파일';
  }
  if (tools.includes('Bash')) return '명령 실행';
  if (tools.every((t) => READONLY_TOOLS.has(t))) return '코드 읽기·검수';
  return '기타 도구';
}

export async function parseSession(f: ScannedFile): Promise<{ session: SessionSummary; skippedLines: number }> {
  const s: SessionSummary = {
    file: f.file,
    projectDir: f.projectDir,
    isSubagentFile: f.isSubagentFile,
    category: '기타·토이',
    firstPrompt: '',
    firstTs: null,
    lastTs: null,
    durationMin: 0,
    userMsgs: 0,
    assistantMsgs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
    perModel: {},
    interruptions: 0,
    compacts: 0,
    slashCommands: [],
    hasSidechain: false,
    cwd: null,
    entrypoint: null,
    toolCounts: {},
    skillUses: {},
    activities: {},
  };
  // 같은 message.id가 여러 라인(콘텐츠 블록별)에 같은 usage를 반복 기록하므로 중복 합산을 막는다
  const seenMessageIds = new Set<string>();
  const msgMeta = new Map<string, MsgMeta>();
  let skippedLines = 0;

  const stream = fs.createReadStream(f.file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (line.length > MAX_LINE_LENGTH) {
        skippedLines++;
        continue;
      }
      if (!line.includes('"type"')) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        skippedLines++;
        continue;
      }
      ingest(obj, s, seenMessageIds, msgMeta);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (s.firstTs !== null && s.lastTs !== null) {
    s.durationMin = Math.max(0, (s.lastTs - s.firstTs) / 60000);
  }
  // 메시지별 도구 사용이 다 모인 뒤에야 활동을 확정할 수 있다
  for (const meta of msgMeta.values()) {
    const act = classifyActivity(meta.tools, meta.exts);
    const a = s.activities[act] ?? (s.activities[act] = { msgs: 0, output: 0, total: 0 });
    a.msgs++;
    a.output += meta.output;
    a.total += meta.total;
  }
  return { session: s, skippedLines };
}

function ingest(obj: any, s: SessionSummary, seenMessageIds: Set<string>, msgMeta: Map<string, MsgMeta>): void {
  if (obj.isCompactSummary === true) s.compacts++;
  if (obj.isSidechain === true) s.hasSidechain = true;
  if (typeof obj.timestamp === 'string') {
    const t = Date.parse(obj.timestamp);
    if (!isNaN(t)) {
      if (s.firstTs === null || t < s.firstTs) s.firstTs = t;
      if (s.lastTs === null || t > s.lastTs) s.lastTs = t;
    }
  }
  if (typeof obj.cwd === 'string' && !s.cwd) s.cwd = obj.cwd;
  if (typeof obj.entrypoint === 'string' && !s.entrypoint) s.entrypoint = obj.entrypoint;

  if (obj.type === 'user') {
    const text = extractText(obj.message?.content);
    if (text === null) return; // tool_result만 있는 기계 메시지
    s.userMsgs++;
    if (text.includes('[Request interrupted')) s.interruptions++;
    const re = /<command-name>([^<]+)<\/command-name>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) s.slashCommands.push(m[1].trim());
    if (!s.firstPrompt) {
      const clean = text.trim();
      if (clean && !isMetaText(clean)) s.firstPrompt = clean.slice(0, 300);
    }
  } else if (obj.type === 'assistant') {
    const msg = obj.message;
    if (!msg) return;
    const id =
      typeof msg.id === 'string' ? msg.id : typeof obj.uuid === 'string' ? obj.uuid : null;
    // 콘텐츠 블록은 같은 id의 여러 라인에 나뉘어 오므로, usage 중복 여부와 무관하게 매 라인에서 모은다
    let meta: MsgMeta | null = null;
    if (id) {
      meta = msgMeta.get(id) ?? null;
      if (!meta) {
        meta = { tools: [], exts: [], output: 0, total: 0 };
        msgMeta.set(id, meta);
      }
    }
    collectToolUse(msg.content, s, meta);
    if (id) {
      if (seenMessageIds.has(id)) return;
      seenMessageIds.add(id);
    }
    s.assistantMsgs++;
    if (msg.usage) {
      addUsage(s, typeof msg.model === 'string' ? msg.model : 'unknown', msg.usage);
      if (meta) {
        const u = msg.usage;
        meta.output += num(u.output_tokens);
        meta.total +=
          num(u.input_tokens) +
          num(u.output_tokens) +
          num(u.cache_read_input_tokens) +
          num(u.cache_creation_input_tokens);
      }
    }
  }
}

function collectToolUse(content: unknown, s: SessionSummary, meta: MsgMeta | null): void {
  if (!Array.isArray(content)) return;
  for (const c of content as any[]) {
    if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
    s.toolCounts[c.name] = (s.toolCounts[c.name] ?? 0) + 1;
    meta?.tools.push(c.name);
    const input = c.input && typeof c.input === 'object' ? c.input : {};
    if (c.name === 'Edit' || c.name === 'Write' || c.name === 'NotebookEdit') {
      const fp =
        typeof input.file_path === 'string'
          ? input.file_path
          : typeof input.notebook_path === 'string'
            ? input.notebook_path
            : '';
      const dot = fp.lastIndexOf('.');
      if (dot > 0 && meta) meta.exts.push(fp.slice(dot + 1).toLowerCase());
    }
    if (c.name === 'Skill' && typeof input.skill === 'string') {
      s.skillUses[input.skill] = (s.skillUses[input.skill] ?? 0) + 1;
    }
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text as string);
    if (parts.length === 0) {
      const hasToolResult = content.some((c: any) => c && c.type === 'tool_result');
      return hasToolResult ? null : '';
    }
    return parts.join('\n');
  }
  return null;
}

function isMetaText(t: string): boolean {
  return (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.includes('<command-name>') ||
    t.startsWith('<system-reminder') ||
    t.startsWith('<task-notification') ||
    t.startsWith('Caveat:')
  );
}

function addUsage(s: SessionSummary, model: string, u: any): void {
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const read = num(u.cache_read_input_tokens);
  const create = num(u.cache_creation_input_tokens);
  let c1h = 0;
  let c5m = 0;
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    c1h = num(u.cache_creation.ephemeral_1h_input_tokens);
    c5m = num(u.cache_creation.ephemeral_5m_input_tokens);
  } else {
    c5m = create;
  }
  s.usage.input += input;
  s.usage.output += output;
  s.usage.cacheRead += read;
  s.usage.cacheCreate5m += c5m;
  s.usage.cacheCreate1h += c1h;

  const pm =
    s.perModel[model] ?? (s.perModel[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  pm.input += input;
  pm.output += output;
  pm.cacheRead += read;
  pm.cacheCreate += c1h + c5m;
}
