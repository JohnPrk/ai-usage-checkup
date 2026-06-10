import type { Coaching, Progress, Report, SnapshotMeta } from '../core/types';

declare global {
  interface Window {
    api: {
      analyze(days: number): Promise<Report>;
      coach(): Promise<Coaching>;
      copy(text: string): Promise<boolean>;
      history(): Promise<SnapshotMeta[]>;
      snapshot(date: string): Promise<Report | null>;
      onProgress(cb: (p: Progress) => void): void;
    };
  }
}

export {};
