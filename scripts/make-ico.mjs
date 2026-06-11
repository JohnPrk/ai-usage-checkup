// build/icon.icns -> build/icon.ico 생성 (Windows 패키징용).
// ImageMagick 없이 macOS 기본 도구(sips)로 사이즈별 PNG를 뽑고,
// PNG-in-ICO(Vista+) 컨테이너로 직접 묶는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const buildDir = new URL('../build/', import.meta.url);
const icns = path.join(buildDir.pathname, 'icon.icns');
const out = path.join(buildDir.pathname, 'icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

// 1) icns에서 1024px PNG 추출
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ico-'));
const iconset = path.join(tmp, 'icon.iconset');
execFileSync('iconutil', ['-c', 'iconset', icns, '-o', iconset]);
const src = fs
  .readdirSync(iconset)
  .map((f) => path.join(iconset, f))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]; // 가장 큰 PNG

// 2) 사이즈별 PNG 생성
const pngs = sizes.map((s) => {
  const p = path.join(tmp, `${s}.png`);
  execFileSync('sips', ['-z', String(s), String(s), src, '--out', p]);
  return { size: s, data: fs.readFileSync(p) };
});

// 3) ICO 조립 (ICONDIR + ICONDIRENTRY[] + PNG data)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4); // count

const entries = [];
const datas = [];
let offset = 6 + pngs.length * 16;
for (const { size, data } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 => 256)
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(data.length, 8); // bytes in resource
  e.writeUInt32LE(offset, 12); // offset
  offset += data.length;
  entries.push(e);
  datas.push(data);
}

fs.writeFileSync(out, Buffer.concat([header, ...entries, ...datas]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[make-ico] ${out} (${sizes.join(',')}px)`);
