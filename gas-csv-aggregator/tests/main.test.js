/**
 * main.js の結合テスト（GAS のモック: tests/gas-mock.js）。仕様 8.2 の観点。
 * 実際の Google 環境での動きは README の「動作確認」でオーナーが確かめる。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGas, settingsRows, filesFromDir, decodeJavaShiftJis, FOLDER_URL, SELF_ID } = require('./gas-mock.js');

const SRC = path.join(__dirname, '..', 'src');
const CASE01 = path.join(__dirname, '..', '..', 'excel-csv-aggregator', 'tests', 'cases', '01-basic', 'input');
const OUTPUT_FOUR = ['設定', '集計', '月別合計', '明細', '取り込み結果'];

const csv = (name, text, extra = {}) => Object.assign({ name, bytes: Buffer.from(text, 'utf8') }, extra);
const HEADER = '注文日,注文番号,商品名,数量,金額\n';
const case01 = (extra = {}) => createGas(Object.assign({ files: filesFromDir(CASE01), settingsRows: settingsRows() }, extra));

// 前回の出力（このツールの見出しを持つ 4 シート）
const previousSheets = () => ({
  '集計': [['年月', '商品', '数量', '金額'], ['2026-01', '前回', 1, 1]],
  '月別合計': [['年月', '数量', '金額'], ['2026-01', 1, 1], ['合計', 1, 1]],
  '明細': [['年月', '日付', '注文番号', '商品', '数量', '金額', '元ファイル', '元の行'], ['2026-01', '2026-01-01', 'X', '前回', 1, 1, 'old.csv', 2]],
  '取り込み結果': [['ファイル', '文字コード', 'データ行', '使った行', '重複で除いた行'], ['old.csv', 'UTF-8', 1, 1, 0]],
});
const textOf = (gas) => Object.fromEntries(gas.sheetNames().map((n) => [n, gas.sheet(n).text()]));

// ---- 正常 ----
test('正常: 4 シートが「設定」の後ろに並び、見出しは灰色・太字・固定、最初のシートが開く', () => {
  const gas = case01({ sheets: { 'メモ': [['依頼者のシート']] } });
  const result = gas.run();
  assert.equal(result.status, 'success');
  assert.deepEqual(gas.sheetNames(), ['設定', '集計', '月別合計', '明細', '取り込み結果', 'メモ']);
  for (const name of ['集計', '月別合計', '明細', '取り込み結果']) {
    const s = gas.sheet(name);
    assert.equal(s.background['1,1'], '#e0e0e0', name);
    assert.equal(s.weight['1,1'], 'bold', name);
    assert.equal(s.frozen, 1, name);
  }
  assert.equal(gas.context.SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName(), '集計');
  assert.deepEqual(gas.sheet('メモ').text(), [['依頼者のシート']]);
  // 月別合計の「合計」行は太字
  const monthly = gas.sheet('月別合計');
  assert.equal(monthly.weight[monthly.getLastRow() + ',1'], 'bold');
  // 使わない列は消す
  assert.equal(gas.sheet('明細').getMaxColumns(), 8);
});

test('正常: 文字の列は @ にしてから書き、数の列は #,##0（小数があれば #,##0.00）', () => {
  const gas = case01();
  gas.run();
  const ev = gas.calls.events;
  const setValuesAt = ev.findIndex((e) => e.op === 'setValues' && e.sheet === '明細（作成中）');
  for (const c of [1, 2, 3, 4, 7]) {
    const fmtAt = ev.findIndex((e) => e.op === 'setNumberFormat' && e.sheet === '明細（作成中）' && e.c === c && e.fmt === '@');
    assert.ok(fmtAt !== -1 && fmtAt < setValuesAt, '明細 ' + c + ' 列目');
  }
  const details = gas.sheet('明細');
  assert.equal(details.format['2,5'], '#,##0');
  assert.equal(details.format['2,6'], '#,##0');
  assert.equal(details.get(12, 4), '0012'); // 文字のまま
  assert.equal(details.get(13, 4), "'=SUM(1,2)"); // FORMULA_GUARD
  assert.equal(details.get(14, 5), -1); // 数の列は ' を付けない
  // 取り込み結果の表の下も文字
  const report = gas.sheet('取り込み結果');
  assert.equal(report.format['7,2'], '@');
  const sjis = createGas({ files: filesFromDir(path.join(CASE01, '..', '..', '06-sjis-fixed-decimal', 'input')),
    settingsRows: settingsRows({ ENCODING: 'Shift_JIS', COL_DATE: 'date', COL_PRODUCT: 'item', COL_QUANTITY: 'qty', COL_AMOUNT: 'amount', COL_ORDER_ID: '' }) });
  assert.equal(sjis.run().status, 'success');
  assert.equal(sjis.sheet('明細').format['2,6'], '#,##0.00');
  // エラーの「行」は 0 の書式
  const err = createGas({ files: [csv('a.csv', HEADER + 'x,1,A,1,1\n')], settingsRows: settingsRows() });
  err.run();
  assert.equal(err.sheet('エラー').format['2,2'], '0');
});

test('エラー: 「エラー」シートの表の下に 1 行空けて実行日時が出る（文字の書式。前回のエラーと見分けるため）', () => {
  const gas = createGas({ files: [csv('a.csv', HEADER + 'x,1,A,1,1\n')], settingsRows: settingsRows() });
  assert.equal(gas.run().status, 'inputError');
  const rows = gas.sheet('エラー').text();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[2], ['', '', '']);
  assert.equal(rows[3][0], '実行日時');
  assert.match(rows[3][1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(gas.sheet('エラー').format['4,2'], '@');
  // 次の実行で、このツールの「エラー」シートとして入れ替えられる
  assert.equal(gas.run().status, 'inputError');
});

test('正常: 明細が 1,000 行を超えても書ける（行を足してから書く）', () => {
  const lines = Array.from({ length: 1500 }, (_, i) => '2026-10-01,A-' + i + ',商品,1,100').join('\n');
  const gas = createGas({ files: [csv('big.csv', HEADER + lines + '\n')], settingsRows: settingsRows() });
  const result = gas.run();
  assert.equal(result.status, 'success', result.message);
  assert.equal(gas.sheet('明細').getLastRow(), 1501);
});

test('入力のバイト列: lib.js には Uint8Array で渡り、BOM つき UTF-8 が「UTF-8（BOM あり）」になる。getBytes は負の数を返す', () => {
  const gas = case01();
  const seen = [];
  const original = gas.context.AggregateFiles;
  gas.context.AggregateFiles = (files, s, d) => { files.forEach((f) => seen.push(Object.prototype.toString.call(f.bytes) === '[object Uint8Array]')); return original(files, s, d); };
  gas.run();
  assert.deepEqual(seen, [true, true, true, true]);
  const report = gas.sheet('取り込み結果').text();
  assert.equal(report[2][1], 'UTF-8（BOM あり）');
  assert.equal(report[1][1], 'Shift_JIS');
  // モックが本当に負の数を返していること（符号の扱いの確認になっている）
  const blob = gas.context.DriveApp.getFolderById('TestFolder0001').getFiles().next().getBlob();
  assert.ok(blob.getBytes().some((b) => b < 0));
});

test('SJIS_CHARSET（windows-31j）が Shift_JIS のファイルの getDataAsString に渡り、UTF-8 のファイルには UTF-8', () => {
  const gas = case01();
  gas.run();
  assert.equal(gas.context.SJIS_CHARSET, 'windows-31j');
  assert.deepEqual(gas.calls.charsets, [
    ['a_2026-08.csv', 'windows-31j'], ['b_2026-09.csv', 'UTF-8'], ['c_2026-09-to-10.csv', 'UTF-8'], ['d_2026-09-crlf.csv', 'UTF-8'],
  ]);
  assert.equal(gas.sheet('明細').get(4, 4), 'ギフトセット ①');
});

// ---- U+FFFD ----
test('モックの Shift_JIS: 2 バイトの組で判定し、「方」（0x95 0xFB）は化けず、①（0x87 0x40）は U+FFFD', () => {
  assert.equal(decodeJavaShiftJis(new Uint8Array([0x95, 0xfb, 0x87, 0x40, 0x41])), '方�A');
});

test('U+FFFD: SJIS_CHARSET を Shift_JIS にするとケース 01 の a_2026-08.csv が行 4（①の行）のエラーになり、「集計」は作られない', () => {
  const gas = case01();
  gas.context.SJIS_CHARSET = 'Shift_JIS';
  const result = gas.run();
  assert.equal(result.status, 'inputError');
  assert.deepEqual(gas.sheetNames(), ['設定', 'エラー']);
  assert.deepEqual(gas.sheet('エラー').table(), [
    ['ファイル', '行', '内容'],
    ['a_2026-08.csv', '4', '文字コードの変換で読めない文字がありました。ENCODING の設定と、ファイルの文字コードを確かめてください'],
  ]);
});

test('U+FFFD: 同じ vm で 1 回目を Shift_JIS でエラーにし、2 回目を windows-31j に戻すと成功する（前の実行の失敗が残らない）', () => {
  const gas = case01();
  gas.context.SJIS_CHARSET = 'Shift_JIS';
  assert.equal(gas.run().status, 'inputError');
  gas.context.SJIS_CHARSET = 'windows-31j';
  const second = gas.run();
  assert.equal(second.status, 'success', second.message);
  assert.deepEqual(gas.sheetNames(), OUTPUT_FOUR);
});

test('SJIS_CHARSET を GAS が受け付けない名前にすると、想定外のエラーとして止まり、前回の結果が残る', () => {
  const gas = case01({ sheets: previousSheets() });
  const before = textOf(gas);
  gas.context.SJIS_CHARSET = 'x-unknown';
  const result = gas.run();
  assert.equal(result.status, 'failed');
  assert.match(result.message, /^想定外のエラーで止まりました: Unsupported charset: x-unknown。元の CSV は変更していません。前回の結果のシートは残っています。$/);
  assert.deepEqual(textOf(gas), before);
});

// ---- flush・入れ替え ----
test('flush: 「（作成中）」を書いたあと、前回のシートを消す前に flush する', () => {
  const gas = case01({ sheets: previousSheets() });
  gas.run();
  const ev = gas.calls.events;
  const flushAt = ev.findIndex((e) => e.op === 'flush');
  const lastWrite = ev.map((e) => e.op).lastIndexOf('setValues');
  const firstOldDelete = ev.findIndex((e) => e.op === 'deleteSheet' && e.sheet === '集計');
  assert.ok(lastWrite < flushAt && flushAt < firstOldDelete);
  assert.equal(gas.calls.flush, 1);
});

test('flush が例外: 「（作成中）」が消え、前回の 4 シートが残り、想定外のエラーの文になる', () => {
  const gas = case01({ sheets: previousSheets(), fail: { flush: true } });
  const before = textOf(gas);
  const result = gas.run();
  assert.equal(result.status, 'failed');
  assert.match(result.message, /前回の結果のシートは残っています。$/);
  assert.deepEqual(textOf(gas), before);
});

test('書き込み中の例外（3 枚目の setValues）: 「（作成中）」が消え、前回の 4 シートが残る', () => {
  const gas = case01({ sheets: previousSheets(), fail: { setValuesAt: 3 } });
  const before = textOf(gas);
  const result = gas.run();
  assert.equal(result.status, 'failed');
  assert.match(result.message, /^想定外のエラーで止まりました: setValues に失敗しました（モック）。/);
  assert.deepEqual(textOf(gas), before);
});

test('入れ替えの途中の例外（2 枚目の deleteSheet）: 入れ替えの途中で止まった文になる', () => {
  const gas = case01({ sheets: previousSheets(), fail: { deleteSheetAt: 2 } });
  const result = gas.run();
  assert.equal(result.status, 'swapFailed');
  assert.equal(result.message, 'シートの入れ替えの途中で止まりました: シートを消せませんでした（モック）。前回の結果のシートは一部が消えている可能性があります。' +
    'もう一度「② 集計する」を実行してください（「（作成中）」のシートは次の実行で消えます）。元の CSV は変更していません。');
  // もう一度実行すれば 1 からやり直せる
  gas.calls.deleteSheet = 100;
  assert.equal(gas.run().status, 'success');
  assert.deepEqual(gas.sheetNames(), OUTPUT_FOUR);
});

test('前回の残り: 「集計（作成中）」が残っていても、消えてから正しく作られる', () => {
  const gas = case01({ sheets: { '集計（作成中）': [['途中']] } });
  assert.equal(gas.run().status, 'success');
  assert.deepEqual(gas.sheetNames(), OUTPUT_FOUR);
});

test('再実行: 2 回実行してもシートの数が増えず、「（作成中）」が残らない', () => {
  const gas = case01();
  gas.run();
  gas.run();
  assert.deepEqual(gas.sheetNames(), OUTPUT_FOUR);
});

test('エラー: 「エラー」シートだけができ、前回の「集計」「月別合計」「明細」「取り込み結果」は消える', () => {
  const gas = createGas({ files: [csv('a.csv', HEADER + '2026-02-30,A,商品,1,100\n')], settingsRows: settingsRows(), sheets: previousSheets() });
  const result = gas.run();
  assert.equal(result.status, 'inputError');
  assert.equal(result.message, '入力に不備が 1 件あったため、集計は作りませんでした。\n「エラー」シートで、ファイル名と行番号を確認してください。前回の集計シートは、今回の結果と取り違えないよう消しました。');
  assert.deepEqual(gas.sheetNames(), ['設定', 'エラー']);
});

// ---- 読まなかったファイル ----
test('自分自身: このスプレッドシートの名前が .csv で終わり、CSV のフォルダにあっても、ID で除いて読まずに集計する（Google 形式のエラーにしない）', () => {
  const files = filesFromDir(CASE01).concat([{ name: '売上集計.csv', id: SELF_ID, mimeType: 'application/vnd.google-apps.spreadsheet', bytes: [] }]);
  const gas = createGas({ files, settingsRows: settingsRows() });
  const result = gas.run();
  assert.equal(result.status, 'success', result.message);
  assert.ok(!gas.calls.getBlob.includes('売上集計.csv'));
  assert.ok(!result.message.includes('売上集計.csv'));
  assert.ok(!JSON.stringify(gas.sheet('取り込み結果').text()).includes('売上集計.csv'));
});

test('読まなかったファイル: ケース 01 の memo.txt・~$a_2026-08.csv がメッセージと「取り込み結果」の表の下に出る。自分自身は出ない', () => {
  const files = filesFromDir(CASE01).concat([{ name: 'CSV 集計ツール', id: SELF_ID, mimeType: 'application/vnd.google-apps.spreadsheet', bytes: [] }]);
  const gas = createGas({ files, settingsRows: settingsRows() });
  const result = gas.run();
  assert.equal(result.status, 'success');
  assert.equal(result.message.split('\n')[1], '読まなかったファイル: 2 件（memo.txt、~$a_2026-08.csv）');
  assert.equal(result.message.split('\n').length, 2);
  const below = gas.sheet('取り込み結果').text().slice(7).map((r) => r.slice(0, 3));
  assert.deepEqual(below, [
    ['フォルダ', 'input（ID: TestFolder0001）', ''],
    ['読まなかったファイル', '2 件', ''],
    ['', 'memo.txt', ''],
    ['', '~$a_2026-08.csv', ''],
    ['サブフォルダ（読みません）', '0 件', ''],
  ]);
  assert.equal(gas.sheet('取り込み結果').text()[6][0], '実行日時');
  assert.match(gas.sheet('取り込み結果').text()[6][1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(result.message, /^集計しました（\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}）。CSV 4 件、明細 13 行（重複で除いた行 2）。/);
});

test('読まなかったファイル: サブフォルダ 2026-09 はメッセージとシートに出て、その中のファイルは読まない。ゴミ箱のものは出さない', () => {
  const gas = case01({
    folders: [{ name: '2026-09', files: [csv('a_2026-08.csv', HEADER + '2026-09-01,Z,商品,1,1\n')] }, { name: '消したフォルダ', trashed: true, files: [] }],
    files: filesFromDir(CASE01).concat([csv('trashed.csv', HEADER, { trashed: true })]),
  });
  const result = gas.run();
  assert.equal(result.status, 'success');
  assert.match(result.message, /\nサブフォルダは読みません: 1 件（2026-09）$/);
  assert.ok(!result.message.includes('trashed.csv'));
  assert.ok(!result.message.includes('消したフォルダ'));
  const below = gas.sheet('取り込み結果').text().slice(-2).map((r) => r.slice(0, 2));
  assert.deepEqual(below, [['サブフォルダ（読みません）', '1 件'], ['', '2026-09']]);
  assert.deepEqual(gas.calls.getBytes, ['a_2026-08.csv', 'b_2026-09.csv', 'c_2026-09-to-10.csv', 'd_2026-09-crlf.csv']);
  assert.ok(!gas.calls.getBlob.includes('trashed.csv'));
  assert.equal(gas.sheet('取り込み結果').text().length, 5 + 1 + 3 + 2 + 2); // 表 5 行・空行・実行日時/フォルダ/読まなかったファイルの 3 行・その 2 件・サブフォルダ 2 行
});

test('読まなかったファイル: 全部が Google スプレッドシート（名前に .csv なし）なら、「CSV が 0 件」の文の後ろに名前と note が出る', () => {
  const files = ['2026-09', '2026-10'].map((name) => ({ name, mimeType: 'application/vnd.google-apps.spreadsheet', bytes: [] }));
  const gas = createGas({ files, settingsRows: settingsRows(), sheets: previousSheets() });
  const before = textOf(gas);
  const result = gas.run();
  assert.equal(result.status, 'stopped');
  assert.equal(result.message, 'フォルダに CSV ファイルがありません: input。シートは変えていません。\n' +
    '読まなかったファイル: 2 件（2026-09、2026-10）\nCSV が Google スプレッドシートに変わっている可能性があります: 2026-09、2026-10');
  assert.deepEqual(textOf(gas), before);
});

test('データ 0 行: 何も書かずに知らせ、読まなかったものも続けて出す', () => {
  const files = [csv('template.csv', HEADER), { name: '2026-10', mimeType: 'application/vnd.google-apps.spreadsheet', bytes: [] }];
  const gas = createGas({ files, settingsRows: settingsRows(), sheets: previousSheets() });
  const before = textOf(gas);
  const result = gas.run();
  assert.equal(result.status, 'stopped');
  assert.equal(result.message, 'CSV にデータの行がありませんでした（見出しだけでした）。集計は作りませんでした。\n' +
    'フォルダと CSV の中身を確認してください: input（ID: TestFolder0001）\nシートは変えていません。\n' +
    '読まなかったファイル: 1 件（2026-10）\nCSV が Google スプレッドシートに変わっている可能性があります: 2026-10');
  assert.deepEqual(textOf(gas), before);
});

// ---- ファイルごとの失敗 ----
test('Google 形式のファイル（名前が x.csv）: そのファイルのエラー（行 0）になり、他のファイルは読まれる', () => {
  const gas = createGas({ settingsRows: settingsRows(), files: [
    csv('a.csv', HEADER + '2026-10-01,A,商品,1,100\n'),
    { name: 'x.csv', mimeType: 'application/vnd.google-apps.spreadsheet', bytes: [] },
  ] });
  assert.equal(gas.run().status, 'inputError');
  assert.deepEqual(gas.sheet('エラー').table().slice(1), [['x.csv', '0', 'Google スプレッドシートなどの Google 形式のファイルは読めません。CSV ファイルのままフォルダに置いてください']]);
  assert.deepEqual(gas.calls.getBytes, ['a.csv']);
});

test('getBlob が例外: そのファイルの「ファイルを読めません: …」が、他のファイルのエラーとファイル名の順に並ぶ', () => {
  const gas = createGas({ settingsRows: settingsRows(), files: [
    csv('c.csv', HEADER + '2026-10-01,C,商品,x,100\n'),
    csv('b.csv', HEADER, { getBlobThrows: 'アクセスが拒否されました' }),
    csv('a.csv', HEADER + '2026-13-01,A,商品,1,100\n'),
  ] });
  assert.equal(gas.run().status, 'inputError');
  const rows = gas.sheet('エラー').table().slice(1);
  assert.deepEqual(rows.map((r) => r.slice(0, 2)), [['a.csv', '2'], ['b.csv', '0'], ['c.csv', '2']]);
  assert.match(rows[0][2], /^「注文日」を日付として読めません/);
  assert.equal(rows[1][2], 'ファイルを読めません: アクセスが拒否されました');
  assert.match(rows[2][2], /^「数量」を数値として読めません/);
});

// ---- 何も書かない場合 ----
function assertNothingWritten(gas, result, pattern) {
  assert.equal(result.status, 'stopped');
  assert.match(result.message, pattern);
  assert.match(result.message, /シートは変えていません/);
  assert.ok(!gas.sheetNames().some((n) => n.endsWith('（作成中）')));
  assert.equal(gas.calls.setValues, 0);
}

test('何も書かない: 「設定」シートがない', () => {
  const gas = createGas({ files: filesFromDir(CASE01), settingsRows: null, sheets: previousSheets() });
  const before = textOf(gas);
  assertNothingWritten(gas, gas.run(), /「設定」シートがありません。メニューの「① 設定シートを作る」を実行してください。/);
  assert.deepEqual(textOf(gas), before);
});

test('何も書かない: 設定のエラー・フォルダが見つからない・同じ名前の CSV・ロックが取れない', () => {
  let gas = case01({ settingsRows: settingsRows({ DEDUPE: 'abc' }), sheets: previousSheets() });
  let before = textOf(gas);
  assertNothingWritten(gas, gas.run(), /・DEDUPE は TRUE か FALSE にしてください/);
  assert.deepEqual(textOf(gas), before);

  gas = case01({ settingsRows: settingsRows({ CSV_FOLDER: 'https://drive.google.com/drive/folders/OtherFolder99' }), sheets: previousSheets() });
  assertNothingWritten(gas, gas.run(), /^フォルダが見つかりません。CSV_FOLDER の URL と、そのフォルダを自分が見られるかを確認してください: https:\/\/drive\.google\.com\/drive\/folders\/OtherFolder99/);

  gas = createGas({ settingsRows: settingsRows(), files: [csv('a.csv', HEADER), csv('a.csv', HEADER), csv('b.csv', HEADER)] });
  assertNothingWritten(gas, gas.run(), /^同じ名前の CSV が 2 つ以上あります。名前を変えるか、片方を別のフォルダに移してください: a\.csv（2 個）/);
  assert.deepEqual(gas.calls.getBytes, []);

  gas = case01({ lock: false });
  assertNothingWritten(gas, gas.run(), /^他の集計が実行中です。/);
});

test('同名の他人のシート: 1 行目が違う「明細」があると、どのファイルも読まずに止まり、そのシートが残る', () => {
  const gas = case01({ sheets: { '明細': [['依頼者のメモ']] } });
  const result = gas.run();
  assertNothingWritten(gas, result, /^「明細」シートは、このツールが作ったものではないようです（1 行目の見出しが違います）。シートの名前を変えてから、もう一度実行してください。/);
  assert.deepEqual(gas.calls.getBytes, []);
  assert.deepEqual(gas.sheet('明細').text(), [['依頼者のメモ']]);
  // 空のシートも「違う」
  const empty = case01({ sheets: { '集計': [] } });
  assert.equal(empty.run().status, 'stopped');
});

test('同名の他人のシート: 読んでいる間に作られても、書く直前の検査で止まる', () => {
  let gas;
  gas = case01({ onGetBytes: (name) => { if (name === 'd_2026-09-crlf.csv') gas.context.SpreadsheetApp.getActiveSpreadsheet().insertSheet('エラー'); } });
  assertNothingWritten(gas, gas.run(), /「エラー」シートは、このツールが作ったものではないようです/);
});

test('同名の他人のシート: 「（作成中）」を書いている間に作られても、消す直前の検査で止まり、そのシートと前回の結果が残る', () => {
  // tester の再現（docs/reviews/gas-csv-aggregator-test.md 推奨 1）: 前回はエラーで「エラー」だけがある。flush の間に依頼者が「集計」を作る
  const previousError = [['ファイル', '行', '内容'], ['a.csv', 2, 'x']];
  const withUserSheetOnFlush = (gas, name) => {
    const ss = gas.context.SpreadsheetApp.getActiveSpreadsheet();
    const realFlush = gas.context.SpreadsheetApp.flush;
    gas.context.SpreadsheetApp.flush = () => {
      ss.insertSheet(name, ss.getSheets().length).getRange(1, 1, 1, 1).setValues([['依頼者が作った大事なメモ']]);
      return realFlush();
    };
  };
  // 成功の経路
  let gas = case01({ sheets: { 'エラー': previousError } });
  withUserSheetOnFlush(gas, '集計');
  let result = gas.run();
  assert.equal(result.status, 'stopped');
  assert.match(result.message, /^「集計」シートは/);
  assert.match(result.message, /シートは変えていません。$/);
  assert.deepEqual(gas.sheetNames(), ['設定', 'エラー', '集計']);
  assert.deepEqual(gas.sheet('集計').text(), [['依頼者が作った大事なメモ']]);
  assert.deepEqual(gas.sheet('エラー').table(), previousError.map((r) => r.map(String)));
  assert.equal(gas.calls.released, true);
  // エラーの経路
  gas = createGas({ settingsRows: settingsRows(), files: [csv('a.csv', HEADER + 'x,1,A,1,1\n')], sheets: previousSheets() });
  withUserSheetOnFlush(gas, 'エラー');
  const before = textOf(gas);
  result = gas.run();
  assert.equal(result.status, 'stopped');
  assert.match(result.message, /^「エラー」シートは/);
  assert.deepEqual(textOf(gas), Object.assign(before, { 'エラー': [['依頼者が作った大事なメモ']] }));
  assert.ok(!gas.sheetNames().some((n) => n.endsWith('（作成中）')));
});

test('時間切れ: 読む前（4 分）と書く前（4 分 30 秒）に、何も書かずに止まる。時間のログは出る', () => {
  let now = 0;
  const clock = () => now;
  let gas = case01({ sheets: previousSheets(), onGetBytes: () => { now += 2.5 * 60 * 1000; } });
  const before = textOf(gas);
  let result = gas.run(clock);
  assertNothingWritten(gas, result, /^時間内に CSV を読み終えられませんでした（4 件のうち 2 件まで）。シートは変えていません。CSV の数を減らしてから実行してください$/);
  assert.deepEqual(textOf(gas), before);
  assert.equal(gas.calls.logs.filter((l) => l.startsWith('時間 読む=')).length, 1);

  now = 0;
  gas = case01({ sheets: previousSheets() });
  const original = gas.context.AggregateFiles;
  gas.context.AggregateFiles = (...a) => { now += 4.6 * 60 * 1000; return original(...a); };
  result = gas.run(clock);
  assertNothingWritten(gas, result, /^集計はできましたが、シートに書く時間が足りない見込みです。/);
  assert.deepEqual(textOf(gas), before);
});

test('時間のログ: 成功・エラーのそれぞれで「時間 読む=」の行が 1 回出る', () => {
  const ok = case01();
  ok.run();
  assert.deepEqual(ok.calls.logs.filter((l) => l.startsWith('時間 読む=')).length, 1);
  assert.match(ok.calls.logs[0], /^時間 読む=\d+ms 集計する=\d+ms 書く=\d+ms ファイル=4 明細=13行$/);
  const err = createGas({ files: [csv('a.csv', HEADER + 'x,1,A,1,1\n')], settingsRows: settingsRows() });
  err.run();
  assert.equal(err.calls.logs.filter((l) => l.startsWith('時間 読む=')).length, 1);
});

// ---- 「設定」を変えない・元の CSV を変えない ----
test('「設定」シートは実行の前後で 1 セルも変わらない。元の CSV の書き換えのメソッドは呼ばれない', () => {
  const gas = case01();
  const before = gas.sheet('設定').text();
  gas.run();
  assert.deepEqual(gas.sheet('設定').text(), before);
  assert.deepEqual(gas.calls.forbidden, []);
  assert.ok(!gas.context.OUTPUT_SHEETS.includes('設定'));
});

// ---- setupSettings ----
test('setupSettings: 新しく作る。プルダウンが付き、値の列が黄色、見出しは固定', () => {
  const gas = createGas({ settingsRows: null });
  gas.context.setupSettings();
  const s = gas.sheet('設定');
  assert.deepEqual(s.text().map((r) => r.slice(0, 2)), [['キー', '値']].concat(gas.context.DEFAULT_SETTINGS.map((d) => [d[0], d[1]])));
  assert.deepEqual(s.text().map((r) => r[2]), ['説明'].concat(gas.context.DEFAULT_SETTINGS.map((d) => d[2])));
  assert.match(s.text().find((r) => r[0] === 'COL_ORDER_ID')[2], /別のファイルにある同じ内容の行は 1 行にまとめます。1 日分を複数のファイルに分けているなら DEDUPE を FALSE に/);
  const rowOf = (key) => s.text().findIndex((r) => r[0] === key) + 1;
  assert.deepEqual(s.validation[rowOf('ENCODING') + ',2'].list, ['自動', 'UTF-8', 'Shift_JIS']);
  assert.deepEqual(s.validation[rowOf('DEDUPE') + ',2'].list, ['TRUE', 'FALSE']);
  assert.deepEqual(s.validation[rowOf('QUOTE_CHECK') + ',2'].list, ['TRUE', 'FALSE']);
  assert.equal(s.background[rowOf('CSV_FOLDER') + ',2'], '#fff8c5');
  assert.equal(s.format[rowOf('DEDUPE') + ',2'], '@');
  assert.equal(s.frozen, 1);
  assert.equal(gas.calls.alerts.length, 1);
});

test('setupSettings: 既に値の入ったキーを上書きせず、足りないキーだけ足す', () => {
  const gas = createGas({ settingsRows: [['CSV_FOLDER', FOLDER_URL, ''], ['DEDUPE', 'FALSE', '']] });
  gas.context.setupSettings();
  const rows = gas.sheet('設定').text();
  assert.deepEqual(rows[1].slice(0, 2), ['CSV_FOLDER', FOLDER_URL]);
  assert.deepEqual(rows[2].slice(0, 2), ['DEDUPE', 'FALSE']);
  assert.deepEqual(rows.slice(1).map((r) => r[0]).sort(), Array.from(gas.context.DEFAULT_SETTINGS, (d) => d[0]).sort());
  gas.context.setupSettings();
  assert.equal(gas.sheet('設定').text().length, 1 + gas.context.DEFAULT_SETTINGS.length);
});

test('onOpen・runAggregation: メニューに 2 つの項目があり、結果を画面に出す', () => {
  const gas = case01();
  gas.context.onOpen();
  assert.deepEqual(gas.calls.menu.items, [['① 設定シートを作る', 'setupSettings'], ['② 集計する', 'runAggregation']]);
  gas.context.runAggregation();
  assert.match(gas.calls.alerts[0], /^集計しました（/);
});

// ---- 自己テスト用の入口（docs/specs/selftest.md 3.2） ----
test('onOpen: runSelfTest があるとき（selftest.js を貼ったとき）だけ「自己テスト（開発用）」が足される', () => {
  const gas = case01();
  gas.context.runSelfTest = () => {};
  gas.context.onOpen();
  assert.deepEqual(gas.calls.menu.items, [['① 設定シートを作る', 'setupSettings'], ['② 集計する', 'runAggregation'], ['自己テスト（開発用）', 'runSelfTest']]);
});

test('aggregateWith_: 設定を渡すと「設定」シートがなくても集計し、出力は先頭に並ぶ。「設定」は読まない', () => {
  const gas = createGas({ files: filesFromDir(CASE01), settingsRows: null, sheets: { 'メモ': [['依頼者のシート']] } });
  const settings = gas.context.readSettings(settingsRows().map((r) => [r[0], r[1]]));
  const result = gas.context.aggregateWith_(undefined, settings);
  assert.equal(result.status, 'success', result.message);
  assert.deepEqual(gas.sheetNames(), ['集計', '月別合計', '明細', '取り込み結果', 'メモ']);
  // 「設定」があっても、渡した設定を使い、「設定」は変わらない
  const withSheet = case01({ settingsRows: settingsRows({ CSV_FOLDER: '' }) });
  const before = withSheet.sheet('設定').text();
  assert.equal(withSheet.context.aggregateWith_(undefined, settings).status, 'success');
  assert.deepEqual(withSheet.sheet('設定').text(), before);
  assert.deepEqual(withSheet.sheetNames(), OUTPUT_FOUR);
});

test('aggregateWith_: 渡した設定も validateSettings を通り、誤りなら何も書かずに止まる', () => {
  const gas = createGas({ files: filesFromDir(CASE01), settingsRows: null });
  const settings = gas.context.readSettings([['CSV_FOLDER', FOLDER_URL], ['QUOTE_CHECK', 'abc']]);
  const result = gas.context.aggregateWith_(undefined, settings);
  assert.equal(result.status, 'stopped');
  assert.match(result.message, /・QUOTE_CHECK は TRUE か FALSE にしてください/);
  assert.deepEqual(gas.sheetNames(), []);
  assert.deepEqual(gas.calls.getBlob, []);
});

test('aggregateFolder: 設定を渡さない本番の入口は、今までどおり「設定」シートを読む（ないと止まる）', () => {
  const gas = createGas({ files: filesFromDir(CASE01), settingsRows: null });
  const result = gas.context.aggregateFolder();
  assert.equal(result.status, 'stopped');
  assert.match(result.message, /「設定」シートがありません/);
});

// ---- 静的な確認 ----
test('静的: appsscript.json の oauthScopes はちょうど 3 つ（外部への送信のスコープがない）', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets.currentonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/script.container.ui',
  ]);
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'Asia/Tokyo');
});

test('静的: src に外部への送信・ファイルの書き換えのメソッドがない', () => {
  const words = ['UrlFetchApp', 'MailApp', 'GmailApp', 'Utilities.newBlob', 'DriveApp.create', '.setContent(', '.setTrashed(', '.moveTo(', '.makeCopy(', '.removeFile(', '.addFile('];
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const w of words) assert.ok(!source.includes(w), f + ' に ' + w);
  }
});

test('静的: SJIS_CHARSET は windows-31j、FORMULA_GUARD は true、閾値は 4 分と 4 分 30 秒', () => {
  const gas = createGas({ settingsRows: null });
  assert.equal(gas.context.SJIS_CHARSET, 'windows-31j');
  assert.equal(gas.context.FORMULA_GUARD, true);
  assert.equal(gas.context.READ_LIMIT_MS, 240000);
  assert.equal(gas.context.WRITE_LIMIT_MS, 270000);
});

// =====================================================================
// tester（2026-10-15）が足した壊れ方の観点。docs/reviews/gas-csv-aggregator-test.md
// =====================================================================
const FFFD = '�';
const row = (date, id, product, qty = 1, amount = 100) => [date, id, product, qty, amount].join(',') + '\n';

// ---- 読まなかったファイル ----
test('tester: 名前の形ごとに、読むか・読まなかったファイルに出るかが決まる（黙って消えない）', () => {
  const body = HEADER + row('2026-10-01', 'A', '商品');
  const gas = createGas({
    settingsRows: settingsRows(),
    files: [
      csv('A_UPPER.CSV', body.replace(',A,', ',U,')), // 拡張子が大文字 → 読む
      csv(' lead-space.csv', body.replace(',A,', ',L,')), // 先頭の空白 → 読む（ListCsvFiles は最後の 4 文字だけを見る）
      csv('a.csv.txt', body), // 読まない
      csv('x.csv ', body), // 最後に半角空白 → 読まない
      csv('y.csv　', body), // 最後に全角空白 → 読まない
      csv('.csv', body), // 名前が拡張子だけ → 読まない（name.length > 4）
      csv('~$lock.CSV', body), // Excel の一時ファイル → 読まない
      { name: 'リンク', mimeType: 'application/vnd.google-apps.shortcut', bytes: [] }, // ショートカット → 読まない（Google 形式）
      { name: 'メモ', mimeType: 'application/vnd.google-apps.document', bytes: [] },
      csv('gone.csv', body, { trashed: true }), // ゴミ箱 → どこにも出ない
    ],
    folders: [{ name: 'sub', files: [csv('in-sub.csv', body)] }],
  });
  const result = gas.run();
  assert.equal(result.status, 'success', result.message);
  assert.deepEqual(gas.calls.getBytes, [' lead-space.csv', 'A_UPPER.CSV']);
  const report = gas.sheet('取り込み結果').text();
  assert.deepEqual(report.slice(1, 3).map((r) => r[0]), [' lead-space.csv', 'A_UPPER.CSV']);
  const skippedStart = report.findIndex((r) => r[0] === '読まなかったファイル');
  assert.equal(report[skippedStart][1], '7 件');
  assert.deepEqual(report.slice(skippedStart + 1, skippedStart + 8).map((r) => [r[1], r[2]]), [
    ['.csv', ''], ['a.csv.txt', ''], ['x.csv ', ''], ['y.csv　', ''], ['~$lock.CSV', ''], ['メモ', 'Google 形式のファイル'], ['リンク', 'Google 形式のファイル'],
  ]);
  assert.deepEqual(report.slice(-2).map((r) => r.slice(0, 2)), [['サブフォルダ（読みません）', '1 件'], ['', 'sub']]);
  assert.ok(!JSON.stringify(report).includes('gone.csv'));
  assert.ok(!JSON.stringify(report).includes('in-sub.csv'));
  assert.ok(!gas.calls.getBlob.includes('in-sub.csv') && !gas.calls.getBlob.includes('gone.csv'));
  assert.match(result.message, /\n読まなかったファイル: 7 件（\.csv、a\.csv\.txt、x\.csv 、y\.csv　、~\$lock\.CSV、メモ、リンク）\nサブフォルダは読みません: 1 件（sub）$/);
});

test('tester: 名前が .csv で終わるショートカットは、読まずにそのファイルのエラー（行 0）になる', () => {
  const gas = createGas({ settingsRows: settingsRows(), files: [
    csv('a.csv', HEADER + row('2026-10-01', 'A', '商品')),
    { name: 'b.csv', mimeType: 'application/vnd.google-apps.shortcut', bytes: [] },
  ] });
  assert.equal(gas.run().status, 'inputError');
  assert.deepEqual(gas.sheet('エラー').table().slice(1).map((r) => r.slice(0, 2)), [['b.csv', '0']]);
  assert.deepEqual(gas.calls.getBlob, ['a.csv']);
});

test('名前が .csv で終わるショートカットのエラーは、「ショートカットは読めません」の専用の文になる（Google スプレッドシートの文にしない）', () => {
  const gas = createGas({ settingsRows: settingsRows(), files: [
    csv('a.csv', HEADER + row('2026-10-01', 'A', '商品')),
    { name: 'b.csv', mimeType: 'application/vnd.google-apps.shortcut', bytes: [] },
    { name: 'c.csv', mimeType: 'application/vnd.google-apps.spreadsheet', bytes: [] },
  ] });
  assert.equal(gas.run().status, 'inputError');
  assert.deepEqual(gas.sheet('エラー').table().slice(1), [
    ['b.csv', '0', 'ショートカットは読めません。元の CSV をこのフォルダにコピーしてください'],
    ['c.csv', '0', 'Google スプレッドシートなどの Google 形式のファイルは読めません。CSV ファイルのままフォルダに置いてください'],
  ]);
});

test('tester: ゴミ箱のファイルと同じ名前の CSV は「同じ名前」にならず、ゴミ箱でないほうを読む', () => {
  const gas = createGas({ settingsRows: settingsRows(), files: [
    csv('a.csv', HEADER + row('2026-10-01', 'OLD', '古い'), { trashed: true, id: 'old' }),
    csv('a.csv', HEADER + row('2026-10-01', 'NEW', '新しい'), { id: 'new' }),
  ] });
  assert.equal(gas.run().status, 'success');
  assert.deepEqual(gas.sheet('明細').text().slice(1).map((r) => r[3]), ['新しい']);
});

test('tester: 同じ名前が大文字・小文字だけ違う（a.csv と A.CSV）なら、両方読む', () => {
  const gas = createGas({ settingsRows: settingsRows(), files: [
    csv('a.csv', HEADER + row('2026-10-01', 'X', '小文字')),
    csv('A.CSV', HEADER + row('2026-10-01', 'Y', '大文字')),
  ] });
  assert.equal(gas.run().status, 'success');
  assert.deepEqual(gas.calls.getBytes, ['A.CSV', 'a.csv']);
});

// ---- U+FFFD ----
test('tester: U+FFFD がファイルの先頭・見出しの中・最後（改行なし）・引用符の中の改行の後ろにあると、それぞれの行のエラーになる', () => {
  const cases = [
    ['先頭', FFFD + HEADER + row('2026-10-01', 'A', '商品'), 1],
    ['見出し', '注文日,注文番号,商品' + FFFD + ',数量,金額\n' + row('2026-10-01', 'A', '商品'), 1],
    ['最後（改行なし）', HEADER + row('2026-10-01', 'A', '商品') + '2026-10-02,B,商品' + FFFD + ',1,100', 3],
    ['CRLF の 3 行目', (HEADER + row('2026-10-01', 'A', '商品') + row('2026-10-02', 'B', FFFD)).replace(/\n/g, '\r\n'), 3],
    ['引用符の中の改行の後ろ', HEADER + '2026-10-01,A,"商品\n2 行目",1,100\n' + row('2026-10-02', 'B', 'x' + FFFD), 4],
  ];
  for (const [label, text, line] of cases) {
    const gas = createGas({ settingsRows: settingsRows(), files: [csv('a.csv', text)] });
    const result = gas.run();
    assert.equal(result.status, 'inputError', label);
    assert.deepEqual(gas.sheet('エラー').table().slice(1), [['a.csv', String(line), gas.context.DECODE_FAILURE_MESSAGE]], label);
    assert.deepEqual(gas.sheetNames(), ['設定', 'エラー'], label);
  }
});

test('tester: U+FFFD が複数のファイルにあり、lib.js のエラー・UTF-16 のファイルと混ざっても、ファイル名の順に 1 件ずつ並ぶ', () => {
  const gas = createGas({ settingsRows: settingsRows(), files: [
    csv('d_utf16.csv', '', { bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(HEADER, 'utf16le')]) }),
    csv('c.csv', HEADER.replace('商品名', '商品名' + FFFD) + row('2026-10-01', 'C', '商品')), // 見出しが化けた → lib.js の「見出しにありません」は捨てる
    csv('b.csv', HEADER + row('2026-13-01', 'B', '商品')), // lib.js のエラー（行 2）
    csv('a.csv', HEADER + row('2026-99-01', 'A', '商品') + row('2026-10-01', 'A2', FFFD)), // 行 2 の日付のエラーより、行 3 の U+FFFD だけを出す
    csv('e.csv', HEADER + row('2026-10-01', 'E', '正しい')),
  ] });
  const result = gas.run();
  assert.equal(result.status, 'inputError');
  const rows = gas.sheet('エラー').table().slice(1);
  assert.deepEqual(rows.map((r) => r.slice(0, 2)), [['a.csv', '3'], ['b.csv', '2'], ['c.csv', '1'], ['d_utf16.csv', '1']]);
  assert.equal(rows[0][2], gas.context.DECODE_FAILURE_MESSAGE);
  assert.match(rows[1][2], /^「注文日」を日付として読めません/);
  assert.equal(rows[2][2], gas.context.DECODE_FAILURE_MESSAGE);
  assert.match(rows[3][2], /UTF-16/);
  assert.match(result.message, /^入力に不備が 4 件あったため/);
});

test('tester: 本当に U+FFFD を含む UTF-8 の CSV も、ENCODING が「自動」「UTF-8」「Shift_JIS」のどれでもエラーで止まる（止まる方向の誤り）', () => {
  for (const enc of ['自動', 'UTF-8', 'Shift_JIS']) {
    const gas = createGas({ settingsRows: settingsRows({ ENCODING: enc }), files: [csv('a.csv', HEADER + row('2026-10-01', 'A', '記号' + FFFD))] });
    assert.equal(gas.run().status, 'inputError', enc);
    assert.equal(gas.sheet('エラー').table()[1][2], gas.context.DECODE_FAILURE_MESSAGE, enc);
  }
});

// ---- 出力のシートの入れ替え ----
test('tester: 4 つの出力シートのうち「月別合計」だけが他人のシートでも、読む前に止まり、どのシートも変わらない', () => {
  const sheets = previousSheets();
  sheets['月別合計'] = [['月', '売上'], ['2026-01', 1]];
  const gas = case01({ sheets });
  const before = textOf(gas);
  const result = gas.run();
  assertNothingWritten(gas, result, /^「月別合計」シートは、このツールが作ったものではないようです/);
  assert.deepEqual(gas.calls.getBytes, []);
  assert.deepEqual(textOf(gas), before);
});

test('tester: 他人のシートが 2 つ（「明細」と「エラー」）あれば、OUTPUT_SHEETS の順で最初の「明細」の名前を出す', () => {
  const gas = case01({ sheets: { 'エラー': [['自分用のメモ']], '明細': [['依頼者']] } });
  assertNothingWritten(gas, gas.run(), /^「明細」シートは/);
});

test('tester: 成功する実行でも、他人の「エラー」シートがあれば止まる（入れ替えで消してしまうため）', () => {
  const gas = case01({ sheets: { 'エラー': [['ファイル', '行', '内容', 'メモ']] } });
  assertNothingWritten(gas, gas.run(), /^「エラー」シートの、表より右の列（D 列から右）に、このツールが使わないセルがあります。そこに書いたものを別のシートに移してから、もう一度実行してください。/);
  assert.deepEqual(gas.sheet('エラー').table(), [['ファイル', '行', '内容', 'メモ']]);
});

test('tester: このツールの「集計」の 2 行目より下で、見出しより右の列に依頼者が書き込むと（getLastColumn が 1 行目より広い）、他人のシートとして止まり、書き込みは消えない', () => {
  const sheets = previousSheets();
  sheets['集計'] = [['年月', '商品', '数量', '金額'], ['2026-01', '前回', 1, 1, '', 'メモ']];
  const gas = case01({ sheets });
  assert.equal(gas.sheet('集計').getLastColumn(), 6);
  const before = textOf(gas);
  // 見出しは合っているので「見出しが違います」とは言わない（テスト結果 任意 6）
  assertNothingWritten(gas, gas.run(), /^「集計」シートの、表より右の列（E 列から右）に、このツールが使わないセルがあります。/);
  assert.deepEqual(textOf(gas), before);
});

test('tester: このツールの「取り込み結果」は、表の下の 3 列目（note）まで書かれていても自分のシートとして入れ替える', () => {
  const sheets = previousSheets();
  sheets['取り込み結果'] = sheets['取り込み結果'].concat([[], ['読まなかったファイル', '1 件'], ['', '2026-10', 'CSV が Google スプレッドシートに変わっている可能性があります']]);
  const gas = case01({ sheets });
  assert.equal(gas.run().status, 'success');
  assert.deepEqual(gas.sheetNames(), OUTPUT_FOUR);
});

test('tester: 「設定」が途中・最後にあっても、出力は「設定」のすぐ後ろに並び、他のシートの並びは変わらない', () => {
  // 「設定」が真ん中
  let gas = createGas({ files: filesFromDir(CASE01), settingsRows: null, sheets: { 'メモ1': [['a']] } });
  gas.sheets.push(new (gas.sheets[0].constructor)('設定', [['キー', '値', '説明']].concat(settingsRows())));
  gas.sheets.push(new (gas.sheets[0].constructor)('メモ2', [['b']]));
  assert.equal(gas.run().status, 'success');
  assert.deepEqual(gas.sheetNames(), ['メモ1', '設定', '集計', '月別合計', '明細', '取り込み結果', 'メモ2']);

  // 前回の出力と「（作成中）」の残りが「設定」より前にある
  const prev = previousSheets();
  gas = createGas({ files: filesFromDir(CASE01), settingsRows: null,
    sheets: Object.assign({ '明細（作成中）': [['途中']], '取り込み結果（作成中）': [['途中']] }, prev, { 'メモ': [['c']] }) });
  gas.sheets.push(new (gas.sheets[0].constructor)('設定', [['キー', '値', '説明']].concat(settingsRows())));
  assert.deepEqual(gas.sheetNames(), ['明細（作成中）', '取り込み結果（作成中）', '集計', '月別合計', '明細', '取り込み結果', 'メモ', '設定']);
  assert.equal(gas.run().status, 'success');
  assert.deepEqual(gas.sheetNames(), ['メモ', '設定', '集計', '月別合計', '明細', '取り込み結果']);

  // エラーのときも「設定」のすぐ後ろ
  gas = createGas({ files: [csv('a.csv', HEADER + row('x', 'A', '商品'))], settingsRows: null, sheets: Object.assign({ 'メモ': [['c']] }, prev) });
  gas.sheets.push(new (gas.sheets[0].constructor)('設定', [['キー', '値', '説明']].concat(settingsRows())));
  assert.equal(gas.run().status, 'inputError');
  assert.deepEqual(gas.sheetNames(), ['メモ', '設定', 'エラー']);
});

test('tester: エラー → 成功 → エラーと続けて実行すると、前回の結果のシートが残らず入れ替わる', () => {
  const good = filesFromDir(CASE01);
  const files = good.slice();
  const gas = createGas({ files, settingsRows: settingsRows() });
  files.push(csv('z.csv', HEADER + row('x', 'Z', '商品')));
  assert.equal(gas.run().status, 'inputError');
  assert.deepEqual(gas.sheetNames(), ['設定', 'エラー']);
  files.pop();
  assert.equal(gas.run().status, 'success');
  assert.deepEqual(gas.sheetNames(), OUTPUT_FOUR);
  files.push(csv('z.csv', HEADER + row('x', 'Z', '商品')));
  assert.equal(gas.run().status, 'inputError');
  assert.deepEqual(gas.sheetNames(), ['設定', 'エラー']);
});

// ---- 時間切れの境目 ----
test('tester: 読む前の閾値（4 分）は「過ぎていたら」止まる。ちょうど・1 ms 前は読み続け、1 ms 後は止まる', () => {
  const limit = 4 * 60 * 1000;
  for (const [elapsed, status] of [[limit - 1, 'success'], [limit, 'success'], [limit + 1, 'stopped']]) {
    let now = 0;
    let first = true;
    const gas = case01({ sheets: previousSheets(), onGetBytes: () => { if (first) { now = elapsed; first = false; } } });
    const result = gas.run(() => now);
    assert.equal(result.status, status, String(elapsed));
    if (status === 'stopped') {
      assert.match(result.message, /^時間内に CSV を読み終えられませんでした（4 件のうち 1 件まで）。/);
      assert.deepEqual(gas.calls.getBytes, ['a_2026-08.csv']);
    }
  }
});

test('tester: 書く前の閾値（4 分 30 秒）も同じ。ちょうど・1 ms 前は書き、1 ms 後は何も書かない', () => {
  const limit = 4 * 60 * 1000 + 30 * 1000;
  for (const [elapsed, status] of [[limit - 1, 'success'], [limit, 'success'], [limit + 1, 'stopped']]) {
    let now = 0;
    const gas = case01({ sheets: previousSheets() });
    const before = textOf(gas);
    const original = gas.context.AggregateFiles;
    gas.context.AggregateFiles = (...a) => { now = elapsed; return original(...a); };
    const result = gas.run(() => now);
    assert.equal(result.status, status, String(elapsed));
    if (status === 'stopped') {
      assert.match(result.message, /^集計はできましたが、シートに書く時間が足りない見込みです。/);
      assert.deepEqual(textOf(gas), before);
      assert.equal(gas.calls.logs.filter((l) => l.startsWith('時間 読む=')).length, 1);
    }
  }
});

test('tester: 閾値を過ぎていても、エラーのときの「エラー」シートも書かない（書く前の検査はエラーの経路にも効く）', () => {
  let now = 0;
  const gas = createGas({ files: [csv('a.csv', HEADER + row('x', 'A', '商品'))], settingsRows: settingsRows(), sheets: previousSheets() });
  const before = textOf(gas);
  const original = gas.context.AggregateFiles;
  gas.context.AggregateFiles = (...a) => { now = 271000; return original(...a); };
  assertNothingWritten(gas, gas.run(() => now), /^集計はできましたが/);
  assert.deepEqual(textOf(gas), before);
});

// ---- FORMULA_GUARD ----
test('tester: FORMULA_GUARD: = + - @ で始まる商品・注文番号・ファイル名・フォルダ名・読まなかったファイル名に \' が付き、全角の ＝ と数の列は変わらない', () => {
  const text = HEADER + [
    row('2026-10-01', '=A1', '=1+1'), row('2026-10-01', '+A2', '+81'), row('2026-10-01', '-A3', '-x'), row('2026-10-01', '@A4', '@x'),
    row('2026-10-01', 'A5', '＝1+1'), row('2026-10-01', 'A6', ' =trim', -2, -980), row('2026-10-01', 'A7', '＋81'),
  ].join('');
  const gas = createGas({ settingsRows: settingsRows(), folderName: '=HYPERLINK("http://example.com")',
    files: [csv('=f.csv', text), csv('@memo.txt', 'x')], folders: [{ name: '+sub', files: [] }] });
  assert.equal(gas.run().status, 'success');
  const d = gas.sheet('明細');
  const products = d.text().slice(1).map((r) => [r[2], r[3]]);
  assert.deepEqual(products, [
    ["'=A1", "'=1+1"], ["'+A2", "'+81"], ["'-A3", "'-x"], ["'@A4", "'@x"], ['A5', '＝1+1'], ['A6', "'=trim"], ['A7', '＋81'],
  ]);
  assert.equal(d.get(7, 5), -2); // 数量・金額は数のまま（'-2 にしない）
  assert.equal(d.get(7, 6), -980);
  assert.equal(d.get(2, 7), "'=f.csv");
  const s = gas.sheet('集計').text().slice(1).map((r) => r[1]);
  assert.ok(s.includes("'=1+1") && s.includes('＝1+1'));
  const report = gas.sheet('取り込み結果').text();
  assert.equal(report[1][0], "'=f.csv");
  const label = report.find((r) => r[0] === 'フォルダ');
  assert.equal(label[1], '\'=HYPERLINK("http://example.com")（ID: TestFolder0001）');
  assert.ok(report.some((r) => r[1] === "'@memo.txt"));
  assert.ok(report.some((r) => r[1] === "'+sub"));
  // 全角の ＋ も対象にしない（仮説: Sheets は全角を数式の始まりにしない。README の数式の確認で確かめる）
});

test('tester: FORMULA_GUARD: 「エラー」シートのファイル名にも付く。FORMULA_GUARD を false にすると、どこにも付かない', () => {
  const err = createGas({ settingsRows: settingsRows(), files: [csv('+e.csv', HEADER + row('x', 'A', '=1'))] });
  assert.equal(err.run().status, 'inputError');
  assert.equal(err.sheet('エラー').get(2, 1), "'+e.csv");
  assert.equal(err.sheet('エラー').get(2, 2), 2); // 行は数のまま

  const off = createGas({ settingsRows: settingsRows(), files: [csv('=f.csv', HEADER + row('2026-10-01', '-A', '=1+1'))] });
  off.context.FORMULA_GUARD = false;
  assert.equal(off.run().status, 'success');
  assert.deepEqual(off.sheet('明細').text()[1].slice(2, 4), ['-A', '=1+1']);
  assert.equal(off.sheet('明細').get(2, 7), '=f.csv');
});

// ---- 「シートは変えていません。」と、ロック ----
test('tester: 何も書かずに止まる文には「シートは変えていません。」がちょうど 1 回あり、書いた・書いたかもしれない文にはない', () => {
  const count = (m) => m.split('シートは変えていません。').length - 1;
  const stops = [];
  stops.push(createGas({ files: filesFromDir(CASE01), settingsRows: null }).run());
  stops.push(case01({ settingsRows: settingsRows({ CSV_FOLDER: '' }) }).run());
  stops.push(case01({ settingsRows: settingsRows({ CSV_FOLDER: 'https://drive.google.com/drive/folders/OtherFolder99' }) }).run());
  stops.push(case01({ sheets: { '集計': [['x']] } }).run());
  stops.push(case01({ lock: false }).run());
  stops.push(createGas({ settingsRows: settingsRows(), files: [csv('memo.txt', 'x')] }).run());
  stops.push(createGas({ settingsRows: settingsRows(), files: [csv('a.csv', HEADER), csv('a.csv', HEADER)] }).run());
  stops.push(createGas({ settingsRows: settingsRows(), files: [csv('a.csv', HEADER)] }).run());
  let now = 0;
  stops.push(case01({ onGetBytes: () => { now = 241000; } }).run(() => now));
  for (const r of stops) {
    assert.equal(r.status, 'stopped', r.message);
    assert.equal(count(r.message), 1, r.message);
  }
  const others = [
    case01().run(),
    createGas({ settingsRows: settingsRows(), files: [csv('a.csv', HEADER + row('x', 'A', '商品'))] }).run(),
    case01({ fail: { flush: true } }).run(),
    case01({ sheets: previousSheets(), fail: { deleteSheetAt: 1 } }).run(),
  ];
  assert.deepEqual(others.map((r) => r.status), ['success', 'inputError', 'failed', 'swapFailed']);
  for (const r of others) assert.equal(count(r.message), 0, r.message);
});

test('tester: ロックは成功・止まる・エラー・想定外のエラー・入れ替えの途中の例外のどれでも外れる', () => {
  const runs = [
    case01(),
    case01({ settingsRows: settingsRows({ DEDUPE: 'x' }) }),
    createGas({ settingsRows: settingsRows(), files: [csv('a.csv', HEADER + row('x', 'A', '商品'))] }),
    case01({ fail: { setValuesAt: 2 } }),
    case01({ sheets: previousSheets(), fail: { deleteSheetAt: 1 } }),
  ];
  for (const gas of runs) {
    gas.run();
    assert.equal(gas.calls.released, true);
  }
});

test('tester: ファイルの一覧の途中でドライブが例外を出すと、想定外のエラーになり、前回の結果は残り、ロックは外れる', () => {
  const gas = case01({ sheets: previousSheets() });
  const before = textOf(gas);
  const real = gas.context.DriveApp.getFolderById('TestFolder0001');
  gas.context.DriveApp = { getFolderById: () => Object.assign({}, real, {
    getFiles: () => { let n = 0; return { hasNext: () => true, next: () => { if (++n > 2) throw new Error('Service error: Drive'); return real.getFiles().next(); } }; },
  }) };
  const result = gas.run();
  assert.equal(result.status, 'failed');
  assert.match(result.message, /^想定外のエラーで止まりました: Service error: Drive。/);
  assert.deepEqual(textOf(gas), before);
  assert.equal(gas.calls.released, true);
});
