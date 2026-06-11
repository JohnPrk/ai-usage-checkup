---
name: rebuild-relaunch
description: >-
  ai-usage-checkup(Electron 데스크탑 앱 "AI 성적표")에서 소스 코드를 추가·수정한 직후,
  그 변경을 패키징된 .app에 반영해 사용자에게 보여줄 때 발동한다. src/ 아래 코드(렌더러·메인·core
  무엇이든)를 바꿨다면 dev 모드로 끝내지 말고 반드시 이 스킬로 "기존 앱 프로세스 종료 → 빌드 →
  electron-builder 패키징 → .app 재실행"까지 수행한다. "빌드해서 보여줘", "앱에 반영", "다시 띄워줘",
  "패키징", ".app에서 보이게", "재실행" 같은 요청은 물론, 기능 추가/수정/버그픽스 작업을 마치고 결과를
  사용자에게 확인시켜야 하는 모든 상황에서 사용한다. 코드를 고치고 나서 사용자에게 미루지 말고 내가 직접 돌린다.
---

# rebuild-relaunch — 코드 수정 후 패키징 앱 재실행

이 프로젝트는 Electron 앱이라, 코드를 고쳐도 이미 실행 중인 앱에는 아무 변화가 없다.
사용자는 dev 모드(`npm start`)가 아니라 **패키징된 `.app`에서 바로 변경이 보이길** 원한다.
그래서 코드 변경이 한 묶음 끝날 때마다 아래 한 줄을 직접 실행한다. 사용자에게 "빌드해 보세요"라고
미루지 않는다.

## 언제 쓰나

- `src/` 아래(렌더러·메인·core) 코드를 추가·수정·삭제한 작업이 끝났을 때
- 사용자가 "반영해줘 / 다시 띄워줘 / .app에서 보이게 / 패키징" 등을 말할 때
- 한 기능/버그픽스 묶음을 끝내고 결과를 사용자가 눈으로 확인해야 할 때

한두 글자 오타 수정처럼 빌드가 의미 없는 변경, 또는 사용자가 "빌드는 하지 마"라고 한 경우는 제외.

## 실행 (이게 전부)

```bash
bash scripts/rebuild-relaunch.sh
```

스크립트가 순서대로 한다:

1. **기존 앱 종료** — 패키징 앱(`release/mac-arm64`에서 실행 중인 것)과 dev 모드(`electron .`) 인스턴스를 `pkill`로 정리. 실행 중인 앱이 파일을 잡고 있으면 패키징이 실패하므로 먼저 죽인다.
2. **NFD 정규화** — `node scripts/ensure-nfd.mjs`. `productName`이 NFC로 남으면 DMG 설치본이 기동 즉시 SIGTRAP으로 죽는다. 빌드 전에 항상 맞춘다.
3. **빌드** — `npm run build` (`tsc` + `index.html`/`style.css` 복사).
4. **패키징** — `npx electron-builder --dir`. DMG를 굽지 않고 `release/mac-arm64/AI 성적표.app`만 빠르게 만든다.
5. **실행** — `open`으로 그 `.app`을 띄운다.

실행 후 사용자에게 "패키징된 앱을 새로 띄웠다"고 한 줄로 알리고, 바뀐 부분을 어디서 보면 되는지 짚어준다.

## 배포용 DMG가 필요할 때만

매 수정 루프에서는 `--dir`로 충분하다(빠름). 실제로 배포할 DMG/설치본을 구워야 할 때만 따로:

```bash
npm run dist        # mac DMG (predist가 NFD 처리)
npm run dist:win    # Windows nsis (x64 고정)
```

## 문제 해결

- **`.app`을 못 찾음** → `electron-builder --dir`가 실패한 것. 위 빌드 로그(`[3/5]`,`[4/5]`)에서 tsc/패키징 에러를 먼저 본다.
- **새 앱에 변경이 안 보임** → 옛 프로세스가 안 죽었을 수 있다. `pgrep -fl "ai-usage-checkup/release"`로 확인하고, 남아 있으면 그 PID를 `kill` 후 다시 스크립트 실행.
- **설치본만 즉시 죽음(SIGTRAP)** → NFD 문제. `node scripts/ensure-nfd.mjs`가 돌았는지 확인. `--dir` 실행본은 APFS라 보통 무관하지만 DMG는 필수.
