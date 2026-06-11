import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Inventory } from './types';

// CLAUDE.md·스킬·훅 설정 자산을 훑는다. 훅은 실행 기록이 로그에 안 남으므로 구성만 보여준다.
export function buildInventory(
  topProjects: { project: string; cwd: string }[],
  skillUseCount: Map<string, number>
): Inventory {
  const home = os.homedir();

  const globalClaudeMd = { exists: false, bytes: 0 };
  try {
    const st = fs.statSync(path.join(home, '.claude', 'CLAUDE.md'));
    globalClaudeMd.exists = true;
    globalClaudeMd.bytes = st.size;
  } catch {
    // 없으면 exists=false 그대로
  }

  // cwd부터 home까지 거슬러 올라가며 CLAUDE.md를 찾는다. woowa_course/CLAUDE.md 처럼
  // 상위 폴더에 둔 규칙도 하위 세션이 상속하므로 "있다"로 본다.
  const projectClaudeMds = topProjects.map(({ project, cwd }) => {
    let dir = cwd;
    while (dir.startsWith(home)) {
      try {
        const st = fs.statSync(path.join(dir, 'CLAUDE.md'));
        return { project, cwd, has: true, bytes: st.size, foundAt: dir };
      } catch {
        // 이 층엔 없음 → 한 단계 위로
      }
      if (dir === home) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return { project, cwd, has: false, bytes: 0 };
  });

  // 커스텀 슬래시 커맨드: ~/.claude/commands 의 *.md 개수
  const customCommands = safeReaddir(path.join(home, '.claude', 'commands')).filter((f) => f.endsWith('.md')).length;

  const skills: Inventory['skills'] = [];
  const skillsDir = path.join(home, '.claude', 'skills');
  for (const name of safeReaddir(skillsDir)) {
    const md = path.join(skillsDir, name, 'SKILL.md');
    let description = '';
    try {
      const head = fs.readFileSync(md, 'utf8').slice(0, 2000);
      const m = head.match(/^description:\s*(.+)$/m);
      if (m) description = m[1].trim().replace(/^["']|["']$/g, '').slice(0, 90);
    } catch {
      continue; // SKILL.md 없는 폴더는 스킬이 아니다
    }
    skills.push({ name, description, uses: skillUseCount.get(name) ?? 0 });
  }
  skills.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));

  const hooks: Inventory['hooks'] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    if (raw?.hooks && typeof raw.hooks === 'object') {
      for (const [event, entries] of Object.entries(raw.hooks as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as any[]) {
          const matcher = typeof entry?.matcher === 'string' ? entry.matcher : '';
          for (const hk of Array.isArray(entry?.hooks) ? entry.hooks : []) {
            if (typeof hk?.command !== 'string') continue;
            // "python3 /path/to/script.py 2>/dev/null" 같은 명령에서 스크립트 이름만 뽑는다
            const word = hk.command.split(/\s+/).find((w: string) => w.includes('/')) ?? hk.command;
            hooks.push({ event, matcher, command: path.basename(word) });
          }
        }
      }
    }
  } catch {
    // settings.json이 없거나 깨져 있으면 훅 없음으로 둔다
  }

  return { globalClaudeMd, projectClaudeMds, skills, hooks, customCommands };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
