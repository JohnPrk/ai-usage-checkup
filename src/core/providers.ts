import { ClaudeAnalyzer } from './analyze';
import { CodexAnalyzer } from './codex/analyze';
import { ProviderId, UsageProvider } from './provider';

// 도구 레지스트리. 새 도구는 BaseAnalyzer를 상속한 뒤 여기 한 줄만 추가하면 cli·main이 자동으로 쓴다.
export const PROVIDERS: Record<ProviderId, UsageProvider> = {
  claude: new ClaudeAnalyzer(),
  codex: new CodexAnalyzer(),
};

export function getProvider(id: ProviderId): UsageProvider {
  return PROVIDERS[id];
}
