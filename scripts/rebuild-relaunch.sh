#!/usr/bin/env bash
# ai-usage-checkup: 코드를 고친 뒤 패키징된 .app에 반영해서 다시 띄운다.
# 흐름: 기존 앱 종료 → productName NFD 정규화 → tsc 빌드 → electron-builder --dir 패키징 → .app 실행
#
# 왜 --dir 인가: 매 수정마다 DMG(114MB 압축)를 다시 굽는 건 느리다.
# --dir 는 release/mac-arm64/<앱>.app 까지만 만들고 DMG/설치본을 건너뛰어 훨씬 빠르다.
# 배포용 DMG가 필요하면 `npm run dist`(predist가 NFD 처리)로 따로 굽는다.
set -euo pipefail

# scripts/의 부모(프로젝트 루트)로 이동
cd "$(dirname "$0")/.."

echo "[1/5] 기존 앱 프로세스 종료"
# 패키징된 앱: 실행 경로가 release/mac-arm64 라서 한글 NFC/NFD 와 무관한 ASCII 경로로 매칭
pkill -f "ai-usage-checkup/release/mac-arm64" 2>/dev/null || true
# 개발 모드(npm start = electron .) 인스턴스
pkill -f "ai-usage-checkup/node_modules/electron" 2>/dev/null || true
# /Applications 설치본(Launchpad가 가리키는 것)도 종료. 한글경로라 pkill 불가 → bundle id로 quit.
osascript -e 'tell application id "com.tinho.ai-usage-checkup" to quit' 2>/dev/null || true
# 완전히 종료될 때까지 대기. 한글경로라 pgrep 매칭이 안 되니 bundle id(ASCII)로 running 만 확인
# ('is running' 은 앱을 실행시키지 않는 안전한 property 조회).
for _ in $(seq 1 20); do
  [ "$(osascript -e 'application id "com.tinho.ai-usage-checkup" is running' 2>/dev/null || echo false)" = "false" ] && break
  sleep 0.3
done

# 앱이 내려간 지금, 렌더러 캐시를 비운다. 안 그러면 새 asar 를 설치해도 Chromium 이 직전
# 실행에서 캐싱한 style.css 를 그려서 CSS/렌더러 변경이 .app 에 안 보인다 (2026-06-15 실측).
node scripts/clear-render-cache.mjs

echo "[2/5] productName NFD 정규화 (DMG/설치본 SIGTRAP 방지)"
node scripts/ensure-nfd.mjs

echo "[3/5] TypeScript 빌드 + 정적 파일 복사"
npm run build

echo "[4/5] .app 패키징 (electron-builder --dir → DMG 생략, 빠름)"
npx electron-builder --dir

echo "[5/5] /Applications 에 설치 후 실행 (Launchpad·Spotlight 최신 유지)"
APP_PATH="$(ls -d release/mac-arm64/*.app 2>/dev/null | head -1)"
if [ -z "$APP_PATH" ]; then
  echo "ERROR: release/mac-arm64 에서 .app 을 찾지 못했다." >&2
  exit 1
fi
# release/ 의 빌드를 바로 열지 않고 /Applications 로 설치한다.
# release/ 만 열면 Launchpad/Spotlight 가 가리키는 /Applications 설치본은 구버전인 채로 남아
# "런치패드에 예전꺼가 뜬다"가 된다 (2026-06-11 이 문제로 추가).
DEST="/Applications/$(basename "$APP_PATH")"
rm -rf "$DEST"
ditto "$APP_PATH" "$DEST"              # ditto: NFD 바이트·심볼릭링크 보존 (cp -R 대신)
xattr -rc "$DEST" 2>/dev/null || true  # 미서명 Gatekeeper 격리 속성 제거
open "$DEST"
echo "완료: '$DEST' (Launchpad 최신) 실행됨"
