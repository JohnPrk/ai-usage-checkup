import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Inventory } from '../types';

// Codex 자산 인벤토리. Claude의 buildInventory와 같은 Inventory 타입으로 채워 renderer를 재사용한다
// (globalClaudeMd 자리 = AGENTS.md). mcpServers·plugins 수는 점수(featureCoverage)용으로 따로 반환한다.
export interface CodexInventory {
  inventory: Inventory;
  mcpServers: number;
  plugins: number;
}

export function buildCodexInventory(
  topProjects: { project: string; cwd: string }[],
  skillUseCount: Map<string, number>
): CodexInventory {
  const home = os.homedir();
  const codex = path.join(home, '.codex');

  // 전역 AGENTS.md (= 전역 CLAUDE.md 대응)
  const globalClaudeMd = { exists: false, bytes: 0 };
  try {
    const st = fs.statSync(path.join(codex, 'AGENTS.md'));
    globalClaudeMd.exists = true;
    globalClaudeMd.bytes = st.size;
  } catch {
    // 없으면 exists=false
  }

  // 프로젝트별 AGENTS.md. Codex cwd는 Windows 경로(D:\)도 섞여 이 머신에서 못 읽으면 has:false로 떨어진다
  const projectClaudeMds = topProjects.map(({ project, cwd }) => {
    try {
      const st = fs.statSync(path.join(cwd, 'AGENTS.md'));
      return { project, cwd, has: true, bytes: st.size, foundAt: cwd };
    } catch {
      return { project, cwd, has: false, bytes: 0 };
    }
  });

  // 스킬: ~/.codex/skills 직속 + .system 내장. 멘션 횟수(skillUseCount)를 uses로 매핑한다
  const skills: Inventory['skills'] = [];
  for (const base of [path.join(codex, 'skills'), path.join(codex, 'skills', '.system')]) {
    for (const name of safeReaddir(base)) {
      if (name.startsWith('.')) continue;
      let description = '';
      try {
        const head = fs.readFileSync(path.join(base, name, 'SKILL.md'), 'utf8').slice(0, 2000);
        const m = head.match(/^description:\s*(.+)$/m);
        if (m) description = m[1].trim().replace(/^["']|["']$/g, '').slice(0, 90);
      } catch {
        continue; // SKILL.md 없는 폴더는 스킬이 아니다
      }
      skills.push({ name, description, uses: skillUseCount.get(name) ?? 0 });
    }
  }
  skills.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));

  // 훅: ~/.codex/hooks.json (Claude는 settings.json, 구조는 동일)
  const hooks: Inventory['hooks'] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(codex, 'hooks.json'), 'utf8'));
    if (raw?.hooks && typeof raw.hooks === 'object') {
      for (const [event, entries] of Object.entries(raw.hooks as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as any[]) {
          const matcher = typeof entry?.matcher === 'string' ? entry.matcher : '';
          for (const hk of Array.isArray(entry?.hooks) ? entry.hooks : []) {
            if (typeof hk?.command !== 'string') continue;
            const word = hk.command.split(/\s+/).find((w: string) => w.includes('/')) ?? hk.command;
            hooks.push({ event, matcher, command: path.basename(word.replace(/['"]/g, '')) });
          }
        }
      }
    }
  } catch {
    // hooks.json 없거나 깨짐 → 훅 없음
  }

  // config.toml: [mcp_servers.NAME] (하위 .env/.* 제외) 와 [plugins."x@y"]
  let mcpServers = 0;
  let plugins = 0;
  try {
    const toml = fs.readFileSync(path.join(codex, 'config.toml'), 'utf8');
    const mcp = new Set<string>();
    for (const m of toml.matchAll(/^\[mcp_servers\.([^.\]]+)\]/gm)) mcp.add(m[1]);
    mcpServers = mcp.size;
    plugins = (toml.match(/^\[plugins\./gm) ?? []).length;
  } catch {
    // config.toml 없음
  }

  return {
    inventory: { globalClaudeMd, projectClaudeMds, skills, hooks, customCommands: 0 },
    mcpServers,
    plugins,
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
