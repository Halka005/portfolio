/**
 * 共通テストケース（tests/cases/）を参照実装で通す。
 * 同じフォルダを、VBA の手動テスト（README の「7. 使用例」「9. 動作確認」）でも使う。
 * 期待値（expected/*.csv）は参照実装から作らず、手で計算して書いたもの。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../src/lib.js');

const CASES = path.join(__dirname, 'cases');

function decode(bytes, enc) {
  return new TextDecoder(enc === lib.ENCODING_SJIS ? 'shift_jis' : 'utf-8', { ignoreBOM: true }).decode(bytes);
}

function runCase(name) {
  const dir = path.join(CASES, name);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const inputDir = path.join(dir, 'input');
  const files = fs.readdirSync(inputDir).map((f) => ({ name: f, bytes: new Uint8Array(fs.readFileSync(path.join(inputDir, f))) }));
  return lib.AggregateFiles(files, settings, decode);
}

function readExpected(name, file) {
  const text = lib.StripBom(fs.readFileSync(path.join(CASES, name, 'expected', file), 'utf8'));
  return lib.ParseCsv(text).map((r) => r.fields);
}

const s = (v) => String(v);
const toSummary = (r) => [['年月', '商品', '数量', '金額']].concat(r.summary.map((x) => [x.ym, x.product, s(x.quantity), s(x.amount)]));
const toMonthly = (r) => {
  const rows = r.monthly.map((x) => [x.ym, s(x.quantity), s(x.amount)]);
  const qty = r.monthly.reduce((a, x) => a + x.quantity, 0);
  const amount = r.monthly.reduce((a, x) => a + x.amount, 0);
  return [['年月', '数量', '金額']].concat(rows, [['合計', s(qty), s(amount)]]);
};
const toDetails = (r) => [['年月', '日付', '注文番号', '商品', '数量', '金額', '元ファイル', '元の行']]
  .concat(r.details.map((x) => [x.ym, x.ymd, x.orderId, x.product, s(x.quantity), s(x.amount), x.file, s(x.line)]));
const toFiles = (r) => [['ファイル', '文字コード', 'データ行', '使った行', '重複で除いた行']]
  .concat(r.reports.map((x) => [x.file, x.encoding, s(x.dataRows), s(x.usedRows), s(x.removed)]));
const toErrors = (r) => [['ファイル', '行', '内容']].concat(r.errors.map((e) => [e.file, s(e.line), e.message]));

for (const name of ['01-basic', '03-no-dedupe', '06-sjis-fixed-decimal']) {
  test(`ケース ${name}: 集計・月別合計・明細・取り込み結果が期待値と一致する`, () => {
    const r = runCase(name);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(toSummary(r), readExpected(name, 'summary.csv'));
    assert.deepEqual(toMonthly(r), readExpected(name, 'monthly.csv'));
    assert.deepEqual(toDetails(r), readExpected(name, 'details.csv'));
    assert.deepEqual(toFiles(r), readExpected(name, 'files.csv'));
  });
}

test('ケース 02-errors: 不備があれば集計を作らず、ファイル名・行番号つきで返す', () => {
  const r = runCase('02-errors');
  assert.equal(r.summary, undefined);
  assert.deepEqual(toErrors(r), readExpected('02-errors', 'errors.csv'));
});

test('ケース 01-basic: 2 回実行しても同じ結果になる（入力を変えない）', () => {
  const before = fs.readdirSync(path.join(CASES, '01-basic', 'input')).map((f) => fs.readFileSync(path.join(CASES, '01-basic', 'input', f)).toString('base64'));
  const r1 = runCase('01-basic');
  const r2 = runCase('01-basic');
  assert.deepEqual(r1, r2);
  const after = fs.readdirSync(path.join(CASES, '01-basic', 'input')).map((f) => fs.readFileSync(path.join(CASES, '01-basic', 'input', f)).toString('base64'));
  assert.deepEqual(after, before);
});

test('ケース 01-basic: ENCODING を UTF-8 に固定すると、Shift_JIS のファイルは文字化けして見出しが見つからない', () => {
  const dir = path.join(CASES, '01-basic');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  settings.encoding = 'UTF-8';
  const files = fs.readdirSync(path.join(dir, 'input')).map((f) => ({ name: f, bytes: new Uint8Array(fs.readFileSync(path.join(dir, 'input', f))) }));
  const r = lib.AggregateFiles(files, settings, decode);
  assert.ok(r.errors.length > 0);
  assert.equal(r.errors[0].file, 'a_2026-08.csv');
  assert.match(r.errors[0].message, /見出しにありません/);
});

test('ケース 04-unclosed-one-file: 4 ファイルのうち 1 つだけ（CR 改行・最後の行）に閉じていない引用符があれば、集計を作らずそのファイルだけを返す。そのレコードの「数量」「金額」が空のエラーは出さない（版 5）', () => {
  const r = runCase('04-unclosed-one-file');
  assert.equal(r.summary, undefined);
  assert.equal(r.noData, undefined);
  assert.deepEqual(toErrors(r), readExpected('04-unclosed-one-file', 'errors.csv'));
  // 見出しだけのファイル・引用符の中の改行が混ざったファイルは、エラーにならずに読めている
  assert.deepEqual(r.reports.map((x) => [x.file, x.dataRows]), [
    ['a_ok.csv', 1], ['b_unclosed-last-line.csv', 2], ['c_header-only.csv', 0], ['d_mixed-newlines.csv', 2],
  ]);
});

test('ケース 04-unclosed-one-file: 閉じていない引用符のファイルを除けば、残りは普通に集計される（引用符の中の改行が混ざっても行がずれない）', () => {
  const dir = path.join(CASES, '04-unclosed-one-file');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const files = fs.readdirSync(path.join(dir, 'input'))
    .filter((f) => f !== 'b_unclosed-last-line.csv')
    .map((f) => ({ name: f, bytes: new Uint8Array(fs.readFileSync(path.join(dir, 'input', f))) }));
  const r = lib.AggregateFiles(files, settings, decode);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.details.map((x) => [x.file, x.line, x.product, x.amount]), [
    ['a_ok.csv', 2, 'テスト A', 100],
    ['d_mixed-newlines.csv', 2, 'テスト D', 300],
    ['d_mixed-newlines.csv', 6, 'テスト D', 400],
  ]);
});

function caseFiles(name) {
  const inputDir = path.join(CASES, name, 'input');
  return fs.readdirSync(inputDir).map((f) => ({ name: f, bytes: new Uint8Array(fs.readFileSync(path.join(inputDir, f))) }));
}

function caseSettings(name, overrides) {
  return Object.assign(JSON.parse(fs.readFileSync(path.join(CASES, name, 'settings.json'), 'utf8')), overrides);
}

test('ケース 05-stray-quotes: 迷子の引用符（例 1〜4）は 4 件のエラーになり、正しい複数行の備考はエラーにならない。集計は作らない', () => {
  const r = runCase('05-stray-quotes');
  assert.equal(r.summary, undefined);
  assert.equal(r.noData, undefined);
  assert.deepEqual(toErrors(r), readExpected('05-stray-quotes', 'errors.csv'));
  // 当たったレコードもデータ行に数える
  assert.deepEqual(r.reports.map((x) => [x.file, x.dataRows]), [
    ['a_example1-text-after-quote.csv', 2], ['b_example2-quote-at-line-end.csv', 2], ['c_example3-middle-column.csv', 1],
    ['d_example4-same-column.csv', 1], ['e_multiline-note-ok.csv', 2],
  ]);
});

test('ケース 05-stray-quotes: QUOTE_CHECK = FALSE なら判定 B（例 2・例 4）は出ず、判定 A（例 1・例 3）の 2 件だけ', () => {
  const r = lib.AggregateFiles(caseFiles('05-stray-quotes'), caseSettings('05-stray-quotes', { quoteCheck: false }), decode);
  const expected = readExpected('05-stray-quotes', 'errors.csv');
  assert.deepEqual(toErrors(r), [expected[0], expected[1], expected[3]]);
});

test('ケース 05-stray-quotes: 正しい複数行の備考のファイルだけなら、普通に集計される', () => {
  const files = caseFiles('05-stray-quotes').filter((f) => f.name === 'e_multiline-note-ok.csv');
  const r = lib.AggregateFiles(files, caseSettings('05-stray-quotes'), decode);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.details.map((x) => [x.line, x.product, x.amount]), [[2, '商品A', 100], [5, '商品B', 200]]);
});

test('ケース 06-sjis-fixed-decimal: ENCODING を「自動」に戻すと、ASCII だけのファイルは UTF-8 と判定される（固定が効いていることの裏付け）', () => {
  const r = lib.AggregateFiles(caseFiles('06-sjis-fixed-decimal'), caseSettings('06-sjis-fixed-decimal', { encoding: '自動' }), decode);
  assert.deepEqual(r.reports.map((x) => [x.file, x.encoding]), [['a_sjis.csv', 'Shift_JIS'], ['b_ascii-only.csv', 'UTF-8']]);
});

// ---- tester 3 回目（仕様 版 5 の 5.5。共通テストケース 05 の改行コード） ----
// ファイルの改行コード（LF / CRLF / CR / 混在）を数える
function newlineStyle(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const cr = (text.match(/\r/g) || []).length - crlf;
  const kinds = [lf > 0 && 'LF', crlf > 0 && 'CRLF', cr > 0 && 'CR'].filter(Boolean);
  return kinds.length === 1 ? kinds[0] : kinds.join('+');
}

test('ケース 05-stray-quotes: 入力は LF のファイルと CRLF のファイルが混ざっている（Excel で開き直して保存すると変わるので、ここで固定する）', () => {
  assert.deepEqual(caseFiles('05-stray-quotes').map((f) => [f.name, newlineStyle(f.bytes)]), [
    ['a_example1-text-after-quote.csv', 'LF'], ['b_example2-quote-at-line-end.csv', 'CRLF'], ['c_example3-middle-column.csv', 'LF'],
    ['d_example4-same-column.csv', 'CRLF'], ['e_multiline-note-ok.csv', 'CRLF'],
  ]);
});

test('ケース 05-stray-quotes: すべてのファイルを LF・CRLF・CR だけ・1 ファイル内の混在に変えても、同じエラー 4 件・同じデータ行になる（QUOTE_CHECK の ON/OFF とも）', () => {
  const expected = readExpected('05-stray-quotes', 'errors.csv');
  const toLf = (s) => s.replace(/\r\n|\r/g, '\n');
  const styles = [
    ['LF', (s) => s],
    ['CRLF', (s) => s.replace(/\n/g, '\r\n')],
    ['CR', (s) => s.replace(/\n/g, '\r')],
    ['混在', (s) => { let k = 0; return s.replace(/\n/g, (m, off, str) => { const c = ['\n', '\r\n', '\r'][k++ % 3]; return c === '\r' && str.charAt(off + 1) === '\n' ? '\r\n' : c; }); }],
  ];
  for (const [style, conv] of styles) {
    const files = caseFiles('05-stray-quotes').map((f) => ({ name: f.name, bytes: new Uint8Array(Buffer.from(conv(toLf(Buffer.from(f.bytes).toString('utf8'))), 'utf8')) }));
    const on = lib.AggregateFiles(files, caseSettings('05-stray-quotes'), decode);
    assert.equal(on.summary, undefined, style);
    assert.deepEqual(toErrors(on), expected, style);
    assert.deepEqual(on.reports.map((x) => x.dataRows), [2, 2, 1, 1, 2], style);
    const off = lib.AggregateFiles(files, caseSettings('05-stray-quotes', { quoteCheck: false }), decode);
    assert.deepEqual(toErrors(off), [expected[0], expected[1], expected[3]], style);
  }
});

test('ケース 05-stray-quotes: 2 回実行しても同じ結果になり、入力のバイト列を変えない', () => {
  const dir = path.join(CASES, '05-stray-quotes', 'input');
  const before = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)).toString('base64'));
  const r1 = runCase('05-stray-quotes');
  const r2 = runCase('05-stray-quotes');
  assert.deepEqual(r1, r2);
  assert.deepEqual(fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)).toString('base64')), before);
});
