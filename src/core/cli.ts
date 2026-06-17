import { getProvider } from './providers';

// 스모크 테스트용 CLI: node dist/core/cli.js --days 30 [--codex]
// Codex 검증: node dist/core/cli.js --codex --days 60  (항상 ~/.codex/sessions 만 읽음)
const i = process.argv.indexOf('--days');
const days = i >= 0 ? Number(process.argv[i + 1]) || 30 : 30;
const provider = getProvider(process.argv.includes('--codex') ? 'codex' : 'claude');

provider
  .run(days, (p) => {
    if (p.done % 50 === 0 || p.done === p.total) {
      process.stderr.write(`${p.phase} ${p.done}/${p.total}\n`);
    }
  })
  .then((r) => {
    const { samples, ...rest } = r;
    console.log(JSON.stringify({ ...rest, sampleCount: samples.length, sampleHead: samples.slice(0, 2) }, null, 2));
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
