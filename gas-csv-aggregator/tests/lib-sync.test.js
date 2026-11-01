/**
 * src/lib.js が excel-csv-aggregator/src/lib.js（集計のルールの唯一の元）のコピーのままかを確かめる（仕様 3.2）。
 * GAS では全ファイルが 1 つのグローバルの名前空間を共有するので、名前のぶつかりと読み込み順もここで見る。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const ORIGINAL = path.join(__dirname, '..', '..', 'excel-csv-aggregator', 'src', 'lib.js');
const GAS_FILES = ['lib.js', 'gas-lib.js', 'main.js'];

const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');

test('src/lib.js は excel-csv-aggregator/src/lib.js とバイト単位で同じ', () => {
  const copy = fs.readFileSync(path.join(SRC, 'lib.js'));
  const original = fs.readFileSync(ORIGINAL);
  assert.ok(copy.equals(original),
    'src/lib.js が元と違います。excel-csv-aggregator/src/lib.js を直してから、gas-csv-aggregator で `npm run sync-lib` を実行してください');
});

// コメントの行（前後の空白を除くと // か * か /* で始まる行）なら許す。正規表現でコメントを消す方法は、文字列の中の // を誤って消すので使わない
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function findNodeOnly(source) {
  const words = ['require(', 'Buffer', 'process.', 'TextDecoder', 'TextEncoder', 'import '];
  const hits = [];
  source.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (isCommentLine(line)) return;
    words.forEach((w) => { if (line.includes(w)) hits.push((i + 1) + ': ' + w); });
  });
  return hits;
}

test('判定の確認: コメントの行は許し、文字列の中に // がある行でも本文なら見つける', () => {
  assert.deepEqual(findNodeOnly([
    '// require( はコメントなので許す',
    ' * TextDecoder もコメント',
    "var url = 'https://example.com'; var b = Buffer.from('x');",
    "var s = '//'; require('fs');",
  ].join('\n')), ['3: Buffer', '4: require(']);
});

test('lib.js に Node.js 専用のもの（require・Buffer・process・TextDecoder・TextEncoder・import）がない', () => {
  assert.deepEqual(findNodeOnly(read('lib.js')), []);
});

test('lib.js の module.exports は typeof module の確認の行より後ろにだけある', () => {
  const lines = read('lib.js').split(/\r\n|\r|\n/);
  const guard = lines.findIndex((l) => l.includes("if (typeof module !== 'undefined')"));
  assert.ok(guard > 0);
  lines.forEach((l, i) => { if (l.includes('module.exports')) assert.ok(i > guard, (i + 1) + ' 行目'); });
});

// ファイルを 1 つだけ空の vm で読み、最上位で宣言した名前（function・var）を集める
function topLevelNames(file) {
  const context = vm.createContext({});
  vm.runInContext(read(file), context, { filename: file });
  return Object.keys(context);
}

test('名前がぶつからない: gas-lib.js・main.js の最上位の名前が、lib.js や互いの最上位の名前と重ならない', () => {
  const names = Object.fromEntries(GAS_FILES.map((f) => [f, topLevelNames(f)]));
  assert.ok(names['lib.js'].includes('AggregateFiles') && names['gas-lib.js'].includes('mergeReadFailures') && names['main.js'].includes('aggregateFolder'));
  for (let i = 0; i < GAS_FILES.length; i++) {
    for (let j = i + 1; j < GAS_FILES.length; j++) {
      const overlap = names[GAS_FILES[i]].filter((n) => names[GAS_FILES[j]].includes(n));
      assert.deepEqual(overlap, [], GAS_FILES[i] + ' と ' + GAS_FILES[j]);
    }
  }
});

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations(list.slice(0, i).concat(list.slice(i + 1))).map((p) => [x].concat(p)));
}

test('読み込み順に依存しない: 3 ファイルを 6 通りの順で読み込んでも、どれもエラーにならない（最上位で他のファイルの名前を使わない）', () => {
  const orders = permutations(GAS_FILES);
  assert.equal(orders.length, 6);
  for (const order of orders) {
    const context = vm.createContext({}); // GAS のサービスも置かない（最上位で使っていないことも確かめる）
    assert.doesNotThrow(() => order.forEach((f) => vm.runInContext(read(f), context, { filename: f })), order.join(' → '));
    assert.equal(typeof context.aggregateFolder, 'function');
  }
});
