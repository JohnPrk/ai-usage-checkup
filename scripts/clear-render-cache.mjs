// 패키징 앱의 렌더러 캐시(Chromium이 file:// 스타일시트·JS를 userData에 캐싱한 것)를 비운다.
//
// 왜 필요한가: rebuild-relaunch 로 asar 를 새로 패키징·설치해도, Chromium 이 직전 실행에서
// 캐싱한 style.css 를 그대로 그려서 "CSS/렌더러만 바꾼 변경이 .app 에 안 보이는" 일이 생긴다
// (2026-06-15 실측: 색 변경이 asar 엔 반영됐는데 화면은 옛 색. 캐시 삭제 후 정상).
// 그래서 앱을 종료한 뒤·재실행 전에 이 캐시 디렉토리만 지운다.
//
// install_id·nickname·snapshots·Local Storage 같은 "데이터"는 절대 건드리지 않는다.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// userData 경로는 Electron 의 app.getName()(= productName) 기준. package.json 에서 그대로 읽는다.
const productName = (pkg.build && pkg.build.productName) || pkg.productName;
if (!productName) {
  console.error('  clear-render-cache: productName 을 package.json 에서 못 찾음 — 건너뜀');
  process.exit(0);
}

const base = path.join(os.homedir(), 'Library', 'Application Support', productName);

// 지워도 다음 실행에 자동 재생성되는 렌더러 캐시들만. (데이터 디렉토리는 제외)
const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'ShaderCache'];

let cleared = 0;
for (const name of cacheDirs) {
  const dir = path.join(base, name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    cleared++;
  }
}
console.log(`  렌더러 캐시 ${cleared}개 디렉토리 정리`);
