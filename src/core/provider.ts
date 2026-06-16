import { Progress, Report } from './types';

export type ProviderId = 'claude' | 'codex';

// 한 AI 코딩 도구의 사용 로그를 분석해 공통 Report로 내놓는 분석기.
// 새 도구(예: Gemini) 추가 = BaseAnalyzer를 상속해 scan/parseAll/aggregate 셋만 구현하면 된다.
export interface UsageProvider {
  readonly id: ProviderId;
  readonly label: string;
  run(days: number, onProgress?: (p: Progress) => void): Promise<Report>;
}

// Template Method: 스캔 → 파싱(진행률) → 집계. 도구별 차이는 세 추상 메서드에만 둔다.
// run()의 오케스트레이션(파일 수집·진행률·집계 호출)은 모든 도구가 공유한다.
export abstract class BaseAnalyzer<F, S> implements UsageProvider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;

  // 분석 기간(일) 안에 든 세션 파일 목록
  protected abstract scan(days: number): F[];
  // 파일들을 파싱해 세션 배열로. 도구별 dedup·정렬 차이를 여기서 흡수하고 스킵 라인 수도 함께 돌려준다
  protected abstract parseAll(
    files: F[],
    onProgress?: (p: Progress) => void
  ): Promise<{ sessions: S[]; skippedLines: number }>;
  // 세션 배열 → 최종 Report (점수·추천·인벤토리까지)
  protected abstract aggregate(days: number, fileCount: number, sessions: S[], skippedLines: number): Report;

  async run(days: number, onProgress?: (p: Progress) => void): Promise<Report> {
    const files = this.scan(days);
    const { sessions, skippedLines } = await this.parseAll(files, onProgress);
    onProgress?.({ phase: '집계 중', done: files.length, total: files.length });
    return this.aggregate(days, files.length, sessions, skippedLines);
  }
}
