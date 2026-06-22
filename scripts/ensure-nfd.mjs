// productName을 NFD로 정규화한다.
// DMG(HFS+)는 파일명을 NFD로 강제하는데 plist/asar 문자열이 NFC로 남으면
// 설치된 앱이 기동 즉시 SIGTRAP으로 죽는다. 빌드 전에 항상 맞춰둔다.
import fs from 'node:fs';

const path = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
const nfd = pkg.productName.normalize('NFD');
if (pkg.productName !== nfd) {
  pkg.productName = nfd;
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[app-name] 앱 이름 호환성을 맞췄다.');
}
