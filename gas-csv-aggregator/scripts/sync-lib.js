/**
 * excel-csv-aggregator/src/lib.js（集計のルールの唯一の元）を、このフォルダの src/lib.js にそのままコピーする。
 * 改行コードも含めて 1 バイトも変えない（tests/lib-sync.test.js で一致を確かめる）。
 * src/lib.js は手で編集しない。直すときは元を直してから `npm run sync-lib` を実行する。
 */
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', '..', 'excel-csv-aggregator', 'src', 'lib.js');
const target = path.join(__dirname, '..', 'src', 'lib.js');

fs.copyFileSync(source, target);
console.log('コピーしました: ' + path.relative(process.cwd(), source) + ' → ' + path.relative(process.cwd(), target));
