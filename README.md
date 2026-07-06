# AI 리포트

![License](https://img.shields.io/github/license/JohnPrk/ai-usage-checkup)
![Release](https://img.shields.io/github/v/release/JohnPrk/ai-usage-checkup)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

Claude Code와 Codex(OpenAI)를 얼마나 잘 쓰고 있는지 진단해주는 데스크탑 앱 (macOS / Windows).

랜딩 페이지: https://johnprk.github.io/ai-usage-checkup/

내 컴퓨터에 남는 세션 로그를 읽어서 리포트를 만든다.

- Claude Code: `~/.claude/projects/**/*.jsonl` (+ `~/.config/claude/projects`)
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

API 키·로그인이 필요 없고 분석은 전부 로컬에서 돈다. 세션 내용·프롬프트·파일 경로는 어디로도 전송되지 않는다.

<br><br>

## 리포트에 담기는 것

1. **종합 판정**: 6축 점수 레이더 + 축별 카드. 전체 순위 참여에 동의하면 익명 랭킹 기반 등수·상위%와 LOL식 9티어(챌린저~브론즈)가, 동의 전에는 절대평가 레벨(Lv.)이 표시된다. 축마다 점수 기준(가점·감점·근거 출처)과 세부 수치를 팝업으로 확인할 수 있다.
2. **핵심 지표**: 토큰량, 캐시 적중률, 예상 비용·절감액, 일별 토큰 차트, 모델 믹스.
3. **사용 내역**: 세션 대화 내용으로 작업 의도를 분류하고(기능 개발 / 버그 수정 / 학습·이해 / 리팩토링 / 글쓰기 / 환경 설정), 활동 비중과 프로젝트 결(우테코 미션 / 개인 프로젝트 / 기타)을 보여준다.
4. **설정 자산·기능 활용**: 공식 기능 커버리지(훅·서브에이전트·MCP·스킬 등)와 CLAUDE.md·스킬·훅 인벤토리.

리포트는 PDF로 저장할 수 있다. 분석할 때마다 스냅샷이 남아, 홈 화면에서 점수 추이(점수 여정)와 이전 결과를 다시 볼 수 있다. 홈에는 클로드 분석 / 코덱스 분석 / 랭킹 버튼이 있다.

<br><br>

## 점수 6축

공용 4축은 두 도구가 같은 공식(`src/core/scoring/core-axes.ts`)으로 채점되어 직접 비교할 수 있고, 나머지 2축은 각 도구 로그에만 있는 신호로 따로 잰다.

| | 공용 4축 | 도구 전용 2축 |
|---|---|---|
| Claude Code | 프롬프트 구체성 · 학습 주도성 · 오류 회복·수렴 · 기능 활용도 | 컨텍스트 운용 · 비용·캐시 효율 |
| Codex | 왼쪽과 동일 (기능 축 이름만 "자산·기능 활용") | 자율 실행 신뢰 · 계획·구조화 |

모든 축은 천장 98점으로 정규화한다. 임계값·가중치는 데이터 앵커로 고정하고 사람에 맞춰 튜닝하지 않는다.

<br><br>

## 익명 랭킹

첫 분석 직전에 "전체 순위 참여" 동의를 묻고, **동의한 경우에만** 점수가 서버(Supabase)로 올라간다. 서버로 나가는 것은 축별 점수와 평균(숫자), 앱 버전, 직접 정한 닉네임(최대 24자, 중복 확인), 설치를 구분하는 랜덤 UUID뿐이다. 거절해도 분석·리포트는 로컬에서 그대로 동작한다(종합 판정은 Lv. 표기로 폴백).

랭킹은 클로드/코덱스를 별도 보드로 나눠 집계하고, 리더보드(페이지당 5명 + 내 행)와 인원 9등분 티어를 보여준다. 백엔드 스키마와 RPC(`submit_and_rank`, `leaderboard`, `set_name` 등)는 `supabase/schema.sql`에 있다.

<br><br>

## 실행

```bash
npm install
npm start
```

GUI 없이 분석만 돌려보기 (스모크 테스트):

```bash
npm run build
node dist/core/cli.js --days 30          # Claude Code
node dist/core/cli.js --days 30 --codex  # Codex
```

<br><br>

## 구조

```
src/
  core/      분석 엔진 (Electron 비의존, CLI로 재사용 가능)
    scanner.ts / parser.ts   Claude 로그 수집·스트리밍 파싱 (메시지 id 중복 합산 방지)
    analyze.ts               집계: 토큰/캐시/모델 믹스/작업 분류/행동 지표
    heuristics.ts            Claude 6축 점수 + 점수 기준 문서
    codex/                   Codex 파이프라인 (scanner/parser/analyze/heuristics/inventory)
    scoring/core-axes.ts     공용 4축 점수 공식 (두 도구 동일 잣대)
    provider.ts / providers.ts  도구 레지스트리 (새 도구는 여기 한 줄 추가)
    inventory.ts             CLAUDE.md·스킬·훅 인벤토리
    tier.ts                  퍼센타일 → 9티어
    remote.ts                Supabase 랭킹 RPC (숫자·닉네임만 전송)
    llm.ts                   opus 코칭 (헤드리스 claude -p, 현재 UI 미노출·MAS 비활성)
  main/      Electron 메인 (IPC, 스냅샷, PDF 저장, 랭킹 동의, MAS 폴더 북마크)
  preload/   contextBridge
  renderer/  리포트 UI (바닐라 TS + 인라인 SVG 차트)
supabase/    랭킹 백엔드 스키마 (schema.sql)
docs/        랜딩 페이지·개인정보 처리방침 (GitHub Pages)
scripts/     NFD 정규화 등 빌드 보조
```

분석 스냅샷은 앱 데이터 폴더(`userData/snapshots/`)에 클로드는 `YYYY-MM-DD.json`, 코덱스는 `YYYY-MM-DD.codex.json`으로 저장된다. 원본 jsonl은 기본 30일 후 삭제되므로, 스냅샷이 장기 추이의 근거가 된다.

<br><br>

## 패키징

```bash
npm run dist:mac        # macOS dmg  → release/AI.Usage.Checkup-<버전>-arm64.dmg
npm run dist:win        # Windows nsis (x64, mac에서 크로스 빌드, 미서명)
npm run dist:mas-store  # App Store(MAS)용 pkg → release/mas-arm64/
```

- **macOS 직접 배포(dmg)**: 로컬 빌드는 미서명이라 처음 열 때 우클릭 → 열기가 필요할 수 있다. `v*.*.*` 태그를 push하면 GitHub Actions(`.github/workflows/release.yml`)가 Developer ID 서명·공증까지 마친 dmg를 GitHub Release에 자동 업로드한다.
- **App Store(MAS)**: 샌드박스라 `~/.claude`·`~/.codex`를 바로 읽을 수 없어, 첫 분석 때 폴더를 한 번 선택받아 security-scoped bookmark로 접근한다(폴더별 별도 허용, 홈 화면의 폴더 설정에서 변경 가능).

**주의: `package.json`의 `productName`은 NFD(자모 분해형)로 저장되어 있다.**
DMG(HFS+)가 파일명을 NFD로 강제하는데 plist·asar 문자열이 NFC로 남으면
둘이 어긋나서 설치된 앱이 실행 즉시 죽는다(SIGTRAP, 에러 메시지 없음).
그래서 파일명·plist·asar를 전부 NFD로 통일한다. 이름을 바꿀 때는 그냥
새 이름을 적으면 되고, 빌드 전에 자동으로 NFD로 정규화된다(`scripts/ensure-nfd.mjs`).

<br><br>

## 기여

버그 제보, 기능 제안, PR을 환영한다. 작업 흐름과 건드리면 안 되는
"오너 소유 파일" 목록은 [CONTRIBUTING.md](CONTRIBUTING.md)에 정리되어 있다.

- 버그 제보·기능 제안: [이슈](https://github.com/JohnPrk/ai-usage-checkup/issues)로 올린다.
- 보안 취약점: 공개 이슈 대신 [SECURITY.md](SECURITY.md)의 방법으로 제보한다.
- 행동 강령: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)를 따른다.

<br><br>

## 라이선스

[MIT](LICENSE)
