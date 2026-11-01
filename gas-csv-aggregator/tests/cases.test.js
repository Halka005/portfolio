/**
 * 共通テストケース（excel-csv-aggregator/tests/cases/01〜06）を、GAS のモックの上で aggregateFolder に流す（仕様 8.3）。
 * 期待値のファイルはコピーせず、相対パスで直接読む。期待値は VBA 版と同じ（手で計算したもの）。
 * 文字の列の期待値には、vm のコンテキストの FORMULA_GUARD で toSheetText を通してから比べる
 * （例: ケース 01 の明細の =SUM(1,2) は '=SUM(1,2)。Sheets が ' をどう見せるかは README の動作確認で確かめる）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../src/lib.js');
const { createGas, settingsRows, filesFromDir } = require('./gas-mock.js');

const CASES = path.join(__dirname, '..', '..', 'excel-csv-aggregator', 'tests', 'cases');

function caseSettings(name, overrides = {}) {
  const s = JSON.parse(fs.readFileSync(path.join(CASES, name, 'settings.json'), 'utf8'));
  return Object.assign({
    ENCODING: s.encoding,
    COL_DATE: s.colNames.date,
    COL_PRODUCT: s.colNames.product,
    COL_QUANTITY: s.colNames.quantity,
    COL_AMOUNT: s.colNames.amount,
    COL_ORDER_ID: s.colNames.orderId,
    DEDUPE: s.dedupe, // Sheets は TRUE を真偽値で返すことがあるので、真偽値のまま入れる
    QUOTE_CHECK: s.quoteCheck === undefined ? true : s.quoteCheck,
  }, overrides);
}

function runCase(name, { overrides, files } = {}) {
  const gas = createGas({ files: files || filesFromDir(path.join(CASES, name, 'input')), settingsRows: settingsRows(caseSettings(name, overrides)) });
  const result = gas.run();
  return { gas, result };
}

// 期待値の CSV を読み、文字の列（textCols、1 から）に toSheetText を通す
function readExpected(gas, name, file, textCols) {
  const text = lib.StripBom(fs.readFileSync(path.join(CASES, name, 'expected', file), 'utf8'));
  const guard = gas.context.FORMULA_GUARD;
  return lib.ParseCsv(text).map((r, i) => r.fields.map((v, j) => (i > 0 && textCols.includes(j + 1) ? gas.context.toSheetText(v, guard) : v)));
}

// 「取り込み結果」は表の部分（見出しと、最初の空行の前まで）だけ比べる。表の下は main.test.js で見る
function reportTable(gas) {
  const rows = gas.sheet('取り込み結果').text();
  const blank = rows.findIndex((r) => r.every((v) => v === ''));
  return rows.slice(0, blank);
}

function assertFourSheets(gas, name) {
  assert.deepEqual(gas.sheetNames(), ['設定', '集計', '月別合計', '明細', '取り込み結果']);
  assert.deepEqual(gas.sheet('集計').text(), readExpected(gas, name, 'summary.csv', [1, 2]));
  assert.deepEqual(gas.sheet('月別合計').text(), readExpected(gas, name, 'monthly.csv', [1]));
  assert.deepEqual(gas.sheet('明細').text(), readExpected(gas, name, 'details.csv', [1, 2, 3, 4, 7]));
  assert.deepEqual(reportTable(gas), readExpected(gas, name, 'files.csv', [1, 2]));
}

function assertErrors(gas, expected) {
  assert.deepEqual(gas.sheetNames(), ['設定', 'エラー']);
  assert.deepEqual(gas.sheet('エラー').table(), expected);
}

for (const name of ['01-basic', '03-no-dedupe', '06-sjis-fixed-decimal']) {
  test(`ケース ${name}: 4 シートが期待値と一致する`, () => {
    const { gas, result } = runCase(name);
    assert.equal(result.status, 'success', result.message);
    assertFourSheets(gas, name);
  });
}

test('ケース 06-sjis-fixed-decimal: DEDUPE が文字の小文字 true でも、真偽値の true でも同じ結果', () => {
  for (const dedupe of ['true', true]) {
    const { gas, result } = runCase('06-sjis-fixed-decimal', { overrides: { DEDUPE: dedupe } });
    assert.equal(result.status, 'success', String(dedupe));
    assertFourSheets(gas, '06-sjis-fixed-decimal');
  }
});

for (const name of ['02-errors', '04-unclosed-one-file', '05-stray-quotes']) {
  test(`ケース ${name}: 「エラー」シートだけができ、errors.csv と一致する`, () => {
    const { gas, result } = runCase(name);
    assert.equal(result.status, 'inputError');
    assertErrors(gas, readExpected(gas, name, 'errors.csv', [1, 3]));
  });
}

test('ケース 05-stray-quotes: QUOTE_CHECK = FALSE なら判定 A の 2 件だけ。空白だけ・行なしなら 4 件', () => {
  const off = runCase('05-stray-quotes', { overrides: { QUOTE_CHECK: 'FALSE' } });
  const expected = readExpected(off.gas, '05-stray-quotes', 'errors.csv', [1, 3]);
  assertErrors(off.gas, [expected[0], expected[1], expected[3]]);
  for (const q of [' 　', undefined]) {
    const r = runCase('05-stray-quotes', { overrides: { QUOTE_CHECK: q } });
    assert.equal(r.result.status, 'inputError', String(q));
    assertErrors(r.gas, expected);
  }
});

test('ケース 05-stray-quotes: 正しい複数行の備考のファイルだけなら、普通に集計される', () => {
  const files = filesFromDir(path.join(CASES, '05-stray-quotes', 'input')).filter((f) => f.name === 'e_multiline-note-ok.csv');
  const { gas, result } = runCase('05-stray-quotes', { files });
  assert.equal(result.status, 'success');
  assert.deepEqual(gas.sheet('明細').text().slice(1).map((r) => [r[7], r[3], r[5]]), [['2', '商品A', '100'], ['5', '商品B', '200']]);
});

test('ケース 05-stray-quotes: すべてのファイルを LF・CRLF・CR に変えても、同じエラー 4 件', () => {
  const toLf = (s) => s.replace(/\r\n|\r/g, '\n');
  for (const [style, conv] of [['LF', (s) => s], ['CRLF', (s) => s.replace(/\n/g, '\r\n')], ['CR', (s) => s.replace(/\n/g, '\r')]]) {
    const files = filesFromDir(path.join(CASES, '05-stray-quotes', 'input'))
      .map((f) => ({ name: f.name, bytes: Buffer.from(conv(toLf(f.bytes.toString('utf8'))), 'utf8') }));
    const { gas, result } = runCase('05-stray-quotes', { files });
    assert.equal(result.status, 'inputError', style);
    assertErrors(gas, readExpected(gas, '05-stray-quotes', 'errors.csv', [1, 3]));
  }
});

test('ケース 04-unclosed-one-file: 閉じていない引用符のファイルを除けば、残りは普通に集計される', () => {
  const files = filesFromDir(path.join(CASES, '04-unclosed-one-file', 'input')).filter((f) => f.name !== 'b_unclosed-last-line.csv');
  const { gas, result } = runCase('04-unclosed-one-file', { files });
  assert.equal(result.status, 'success');
  assert.deepEqual(gas.sheet('明細').text().slice(1).map((r) => [r[6], r[7], r[3], r[5]]), [
    ['a_ok.csv', '2', 'テスト A', '100'], ['d_mixed-newlines.csv', '2', 'テスト D', '300'], ['d_mixed-newlines.csv', '6', 'テスト D', '400'],
  ]);
});

test('ケース 06-sjis-fixed-decimal: ENCODING を「自動」に戻すと、ASCII だけのファイルは UTF-8 と判定される', () => {
  const { gas } = runCase('06-sjis-fixed-decimal', { overrides: { ENCODING: '自動' } });
  assert.deepEqual(reportTable(gas).slice(1).map((r) => [r[0], r[1]]), [['a_sjis.csv', 'Shift_JIS'], ['b_ascii-only.csv', 'UTF-8']]);
});

// GAS 版だけ期待が変わる派生テスト（仕様 8.3）: U+FFFD の検査が先に効く
test('ケース 01-basic: ENCODING を UTF-8 に固定すると、a_2026-08.csv は行 1 の「文字コードの変換で読めない文字」になり、「見出しにありません」は出ない', () => {
  const { gas, result } = runCase('01-basic', { overrides: { ENCODING: 'UTF-8' } });
  assert.equal(result.status, 'inputError');
  const rows = gas.sheet('エラー').table().slice(1);
  assert.deepEqual(rows[0], ['a_2026-08.csv', '1', gas.context.DECODE_FAILURE_MESSAGE]);
  assert.equal(rows.filter((r) => r[0] === 'a_2026-08.csv').length, 1);
  assert.ok(!rows.some((r) => r[0] === 'a_2026-08.csv' && /見出しにありません/.test(r[2])));
});

test('ケース 01-basic: 2 回実行しても、実行日時のセルを除いて同じ結果になり、入力のバイト列を変えない', () => {
  const files = filesFromDir(path.join(CASES, '01-basic', 'input'));
  const before = files.map((f) => f.bytes.toString('base64'));
  const gas = createGas({ files, settingsRows: settingsRows(caseSettings('01-basic')) });
  const snapshot = () => gas.sheetNames().map((n) => [n, gas.sheet(n).text().map((r) => (r[0] === '実行日時' ? [r[0]] : r))]);
  gas.run();
  const first = snapshot();
  gas.run();
  assert.deepEqual(snapshot(), first);
  assert.deepEqual(files.map((f) => f.bytes.toString('base64')), before);
  assert.deepEqual(gas.calls.forbidden, []);
});
