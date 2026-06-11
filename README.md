# AI 성적표

Claude Code를 얼마나 잘 쓰고 있는지 진단해주는 데스크탑 앱 (Mac / Windows).

내 컴퓨터의 `~/.claude/projects/*.jsonl` (최근 30일 세션 기록)을 읽어서:

1. 무엇에 썼는지 구조화 (미션 개발 / 학습 / 글·회고 / 기타)
2. 5개 축 점수화 (프롬프트 구체성, 학습 주도성, 컨텍스트 운용, 비용·캐시 효율, 기능 활용도)
3. 규칙 기반 추천 (지금 → 이렇게, 복사해서 쓸 스크립트 포함)
4. opus 코칭 (선택): 로그인된 claude CLI를 구독 인증으로 1회 호출해 프롬프트 단위 피드백

API 키가 필요 없다. 분석은 전부 로컬에서 돌고, opus 코칭을 누를 때만
세션 첫 메시지 일부(최대 12개)가 본인 Claude 계정으로 전송된다.

<br><br>

## 실행

```bash
npm install
npm start
```

GUI 없이 분석만 돌려보기 (스모크 테스트):

```bash
npm run build
node dist/core/cli.js --days 30
```

<br><br>

## 구조

```
src/
  core/      분석 엔진 (Electron 비의존, CLI로 재사용 가능)
    scanner.ts     jsonl 파일 수집 (~/.claude/projects, ~/.config/claude/projects)
    parser.ts      스트리밍 파싱 (메시지 id 중복 합산 방지 포함)
    analyze.ts     집계: 토큰/캐시/모델 믹스/작업 분류/행동 지표
    heuristics.ts  점수 5축 + 규칙 기반 추천
    llm.ts         opus 코칭 (claude -p 헤드리스, --no-session-persistence)
  main/      Electron 메인 프로세스 (IPC, 스냅샷 저장)
  preload/   contextBridge
  renderer/  리포트 UI (바닐라 TS)
```

분석 스냅샷은 앱 데이터 폴더(`userData/snapshots/`)에 날짜별로 저장된다.
원본 jsonl은 기본 30일 후 삭제되므로, 스냅샷이 장기 추이의 근거가 된다.

<br><br>

## 패키징 (mac dmg)

```bash
npm run dist   # release/AI 성적표-0.4.0-arm64.dmg
```

미서명(ad-hoc) 빌드라서 받은 쪽에서 처음 열 때 우클릭 → 열기가 필요할 수 있다.

**주의: `package.json`의 `productName`은 NFD(자모 분해형)로 저장되어 있다.**
DMG(HFS+)가 파일명을 NFD로 강제하는데 plist·asar 문자열이 NFC로 남으면
둘이 어긋나서 설치된 앱이 실행 즉시 죽는다(SIGTRAP, 에러 메시지 없음).
그래서 파일명·plist·asar를 전부 NFD로 통일한다. 이름을 바꿀 때는 그냥
새 이름을 적으면 되고, `npm run dist`가 빌드 전에 자동으로 NFD로
정규화한다(`scripts/ensure-nfd.mjs`).
