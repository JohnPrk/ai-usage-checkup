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
sleep 1

echo "[2/5] productName NFD 정규화 (DMG/설치본 SIGTRAP 방지)"
node scripts/ensure-nfd.mjs

echo "[3/5] TypeScript 빌드 + 정적 파일 복사"
npm run build

echo "[4/5] .app 패키징 (electron-builder --dir → DMG 생략, 빠름)"
npx electron-builder --dir

echo "[5/5] 패키징된 앱 실행"
APP_PATH="$(ls -d release/mac-arm64/*.app 2>/dev/null | head -1)"
if [ -z "$APP_PATH" ]; then
  echo "ERROR: release/mac-arm64 에서 .app 을 찾지 못했다." >&2
  exit 1
fi
open "$APP_PATH"
echo "완료: '$APP_PATH' 실행됨"
