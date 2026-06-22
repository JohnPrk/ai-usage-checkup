import type { Coaching, LeaderboardView, Progress, RankView, Report, SnapshotMeta } from '../core/types';

declare global {
  interface Window {
    api: {
      analyze(days: number): Promise<Report | { status: 'need_access' }>;
      analyzeCodex(days: number): Promise<Report>;
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
      leaderboard(): Promise<LeaderboardView | null>;
      getNickname(): Promise<{ name: string; chosen: boolean }>;
      setNickname(name: string): Promise<string>;
      getRankConsent(): Promise<'yes' | 'no' | 'unset'>;
      setRankConsent(agree: boolean): Promise<'yes' | 'no'>;
      submitCurrent(): Promise<RankView | null>;
      chooseClaudeDir(): Promise<{ ok: boolean; path?: string }>;
      claudeAccess(): Promise<{ isMas: boolean; hasAccess: boolean }>;
      onProgress(cb: (p: Progress) => void): void;
    };
  }
}

export {};
