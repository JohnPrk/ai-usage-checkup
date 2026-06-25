import type { Coaching, LeaderboardView, Progress, RankView, Report, SnapshotMeta } from '../core/types';

declare global {
  interface Window {
    api: {
      analyze(days: number): Promise<Report | { status: 'need_access' }>;
      analyzeCodex(days: number): Promise<Report | { status: 'need_access' }>;
      coach(): Promise<Coaching>;
      copy(text: string): Promise<boolean>;
      saveReportPdf(
        suggestedName: string,
        layout?: { width: number; height: number }
      ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      history(): Promise<SnapshotMeta[]>;
      snapshot(date: string, source?: 'claude' | 'codex'): Promise<Report | null>;
      rank(): Promise<RankView | null>;
      latestRank(): Promise<RankView | null>;
      leaderboard(page?: number, source?: 'claude' | 'codex'): Promise<LeaderboardView | null>;
      getNickname(): Promise<{ name: string; chosen: boolean }>;
      setNickname(name: string): Promise<string>;
      checkNickname(name: string): Promise<{ available: boolean }>;
      getRankConsent(): Promise<'yes' | 'no' | 'unset'>;
      setRankConsent(agree: boolean): Promise<'yes' | 'no'>;
      submitCurrent(): Promise<RankView | null>;
      chooseClaudeDir(): Promise<{ ok: boolean; path?: string; mismatch?: boolean }>;
      chooseCodexDir(): Promise<{ ok: boolean; path?: string; mismatch?: boolean }>;
      claudeAccess(): Promise<{ isMas: boolean; hasAccess: boolean }>;
      access(): Promise<{
        isMas: boolean;
        claude: { granted: boolean; path: string | null };
        codex: { granted: boolean; path: string | null };
      }>;
      onProgress(cb: (p: Progress) => void): void;
    };
  }
}

export {};
