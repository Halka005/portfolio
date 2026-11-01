/**
 * src/gas-lib.js（GAS 版だけの純粋関数）の単体テスト。
 * GAS では lib.js の関数がグローバルにあるので、ここでも lib.js の公開している名前をグローバルに置いてから読み込む。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../src/lib.js');
Object.assign(globalThis, lib);
const g = require('../src/gas-lib.js');

// ---- extractFolderId ----
test('extractFolderId: URL の形ごとにフォルダの ID を取り出す', () => {
  const id = '1AbCdEfGhIjK_lm-n';
  assert.equal(g.extractFolderId('https://drive.google.com/drive/folders/' + id), id);
  assert.equal(g.extractFolderId('https://drive.google.com/drive/u/0/folders/' + id + '?usp=sharing'), id);
  assert.equal(g.extractFolderId('https://drive.google.com/open?id=' + id), id);
  assert.equal(g.extractFolderId('https://drive.google.com/drive/folders?resourcekey=xx&id=' + id), id);
  assert.equal(g.extractFolderId(id), id);
  assert.equal(g.extractFolderId(' 　' + id + '\t '), id);
  assert.equal(g.extractFolderId('"https://drive.google.com/drive/folders/' + id + '"'), id);
});

test('extractFolderId: ID を取れないものは空', () => {
  assert.equal(g.extractFolderId('https://drive.google.com/file/d/1AbCdEfGhIjK/view'), '');
  assert.equal(g.extractFolderId(''), '');
  assert.equal(g.extractFolderId(null), '');
  assert.equal(g.extractFolderId('abcdefghi'), ''); // 9 文字
  assert.equal(g.extractFolderId('売上のフォルダ'), '');
});

// ---- readSettings ----
const rowsOf = (obj) => Object.entries(obj).map(([k, v]) => [k, v]);

test('readSettings: 真偽値・文字の TRUE/true/False を TRUE / FALSE の文字にする', () => {
  assert.equal(g.readSettings([['DEDUPE', true], ['QUOTE_CHECK', false]]).DEDUPE, 'TRUE');
  assert.equal(g.readSettings([['DEDUPE', true], ['QUOTE_CHECK', false]]).QUOTE_CHECK, 'FALSE');
  assert.equal(g.readSettings([['DEDUPE', 'true']]).DEDUPE, 'TRUE');
  assert.equal(g.readSettings([['DEDUPE', 'False']]).DEDUPE, 'FALSE');
  assert.equal(g.readSettings([['DEDUPE', 'TRUE']]).DEDUPE, 'TRUE');
});

test('readSettings: 空・空白だけ・キーの行なしなら、QUOTE_CHECK は TRUE、DEDUPE は空のまま', () => {
  for (const rows of [[], [['QUOTE_CHECK', ''], ['DEDUPE', '']], [['QUOTE_CHECK', ' 　 '], ['DEDUPE', null]]]) {
    const s = g.readSettings(rows);
    assert.equal(s.QUOTE_CHECK, 'TRUE');
    assert.equal(s.DEDUPE, '');
    assert.equal(s.CSV_FOLDER, '');
  }
});

test('readSettings: 数値の見出し名は文字に、同じキーが 2 行なら上の行、キーの前後の空白は無視', () => {
  const s = g.readSettings([[' COL_DATE　', 2026], ['COL_DATE', '日付'], ['', 'x'], [null, 'y']]);
  assert.equal(s.COL_DATE, '2026');
  assert.deepEqual(Object.keys(s), g.DEFAULT_SETTINGS.map((d) => d[0]));
});

test('DEFAULT_SETTINGS: 説明の文は VBA 版の「設定」シートと同じ（CSV_FOLDER と COL_AMOUNT 以外）。COL_ORDER_ID に空にしたときの注意がある', () => {
  const bas = fs.readFileSync(path.join(__dirname, '..', '..', 'excel-csv-aggregator', 'src', 'CsvAggregator.bas'), 'utf8');
  const vba = {};
  for (const m of bas.matchAll(/Array\("([A-Z_]+)", [^,]+, "((?:[^"]|"")*)"\)/g)) vba[m[1]] = m[2].replace(/""/g, '"');
  const gas = Object.fromEntries(g.DEFAULT_SETTINGS.map((d) => [d[0], d[2]]));
  for (const key of ['ENCODING', 'COL_DATE', 'COL_PRODUCT', 'COL_QUANTITY', 'COL_ORDER_ID', 'DEDUPE', 'QUOTE_CHECK']) {
    assert.equal(gas[key], vba[key], key);
  }
  assert.match(gas.COL_ORDER_ID, /空にした場合、別のファイルにある同じ内容の行は 1 行にまとめます。1 日分を複数のファイルに分けているなら DEDUPE を FALSE に$/);
  assert.equal(gas.ENCODING, 'CSV の文字コード。自動 / UTF-8 / Shift_JIS。文字化けしたときだけ変える');
});

test('googleFormatMessage: ショートカットだけ専用の文、それ以外の Google 形式は共通の文', () => {
  assert.equal(g.googleFormatMessage('application/vnd.google-apps.shortcut'), 'ショートカットは読めません。元の CSV をこのフォルダにコピーしてください');
  assert.equal(g.googleFormatMessage('application/vnd.google-apps.spreadsheet'), g.GOOGLE_FORMAT_MESSAGE);
  assert.equal(g.googleFormatMessage('application/vnd.google-apps.document'), g.GOOGLE_FORMAT_MESSAGE);
});

test('foreignSheetMessage: 見出しが同じで右に列が多いだけなら「表より右の列」の文、見出しが違えば「見出しが違います」の文', () => {
  assert.equal(g.foreignSheetMessage('集計', ['年月', '商品', '数量', '金額', '', '']),
    '「集計」シートの、表より右の列（E 列から右）に、このツールが使わないセルがあります。そこに書いたものを別のシートに移してから、もう一度実行してください。');
  assert.match(g.foreignSheetMessage('明細', g.OUTPUT_HEADERS['明細'].concat(['メモ'])), /^「明細」シートの、表より右の列（I 列から右）に/);
  const differ = '「集計」シートは、このツールが作ったものではないようです（1 行目の見出しが違います）。シートの名前を変えてから、もう一度実行してください。';
  assert.equal(g.foreignSheetMessage('集計', ['年月', '売上', '数量', '金額', '']), differ);
  assert.equal(g.foreignSheetMessage('集計', ['依頼者のメモ']), differ);
  assert.equal(g.foreignSheetMessage('集計', []), differ);
});

// ---- validateSettings ----
const okSettings = () => g.readSettings(rowsOf({
  CSV_FOLDER: 'https://drive.google.com/drive/folders/1AbCdEfGhIjK', ENCODING: '自動', COL_DATE: '注文日', COL_PRODUCT: '商品名',
  COL_QUANTITY: '数量', COL_AMOUNT: '金額', COL_ORDER_ID: '', DEDUPE: 'TRUE', QUOTE_CHECK: 'TRUE',
}));

test('validateSettings: 正しい設定なら空', () => {
  assert.equal(g.validateSettings(okSettings()), '');
});

test('validateSettings: VBA 版の ValidateSettings と同じ文言を使う', () => {
  const bas = fs.readFileSync(path.join(__dirname, '..', '..', 'excel-csv-aggregator', 'src', 'CsvAggregator.bas'), 'utf8');
  for (const words of ['・ENCODING は「', '」のどれかにしてください', '・DEDUPE は TRUE か FALSE にしてください', '・QUOTE_CHECK は TRUE か FALSE にしてください', ' が空です', '「設定」シートを確認してください（キーがない場合は ']) {
    assert.ok(bas.includes(words), words);
  }
  const s = Object.assign(okSettings(), { ENCODING: 'EUC-JP', DEDUPE: 'YES', QUOTE_CHECK: 'ABC', COL_AMOUNT: '' });
  assert.equal(g.validateSettings(s), [
    '「設定」シートを確認してください（キーがない場合は ① 設定シートを作る を実行）。',
    '・COL_AMOUNT が空です',
    '・ENCODING は「自動」「UTF-8」「Shift_JIS」のどれかにしてください',
    '・DEDUPE は TRUE か FALSE にしてください',
    '・QUOTE_CHECK は TRUE か FALSE にしてください',
  ].join('\n'));
});

test('validateSettings: CSV_FOLDER が空・ID を取れない', () => {
  assert.match(g.validateSettings(Object.assign(okSettings(), { CSV_FOLDER: '' })), /・CSV_FOLDER が空です。CSV を入れた Google ドライブのフォルダの URL を貼ってください/);
  assert.match(g.validateSettings(Object.assign(okSettings(), { CSV_FOLDER: 'https://drive.google.com/file/d/1AbCdEfGhIjK/view' })),
    /・CSV_FOLDER から Google ドライブのフォルダの ID を読み取れません: https:\/\/drive\.google\.com\/file\/d\/1AbCdEfGhIjK\/view/);
});

test('validateSettings: 複数のエラーを 1 つにまとめる', () => {
  const msg = g.validateSettings(g.readSettings([]));
  // 先頭の文 + CSV_FOLDER + COL_ 4 つ + ENCODING（空） + DEDUPE（空）。QUOTE_CHECK は空なら TRUE なのでエラーにならない
  assert.deepEqual(msg.split('\n').map((l) => l.split(' ')[0]),
    ['「設定」シートを確認してください（キーがない場合は', '・CSV_FOLDER', '・COL_DATE', '・COL_PRODUCT', '・COL_QUANTITY', '・COL_AMOUNT', '・ENCODING', '・DEDUPE']);
});

// ---- findDuplicateNames ----
test('findDuplicateNames: 重なりなし・2 つ・3 つ・大文字と小文字だけ違う', () => {
  assert.deepEqual(g.findDuplicateNames(['a.csv', 'b.csv']), []);
  assert.deepEqual(g.findDuplicateNames(['a.csv', 'a.csv', 'b.csv', 'b.csv', 'b.csv']), [{ name: 'a.csv', count: 2 }, { name: 'b.csv', count: 3 }]);
  assert.deepEqual(g.findDuplicateNames(['A.csv', 'a.csv']), []);
});

// ---- listSkippedItems ----
const entry = (name, mimeType = 'text/csv', id = 'id-' + name) => ({ name, id, mimeType });

test('listSkippedItems: ケース 01 では memo.txt と ~$a_2026-08.csv が出て、読む CSV は出ない', () => {
  const entries = ['a_2026-08.csv', 'b_2026-09.csv', 'c_2026-09-to-10.csv', 'd_2026-09-crlf.csv', 'memo.txt', '~$a_2026-08.csv']
    .map((n) => entry(n, n.endsWith('.txt') ? 'text/plain' : 'text/csv'));
  const names = lib.ListCsvFiles(entries.map((e) => e.name));
  assert.deepEqual(g.listSkippedItems(entries, names, 'SELF', []), {
    files: [{ name: 'memo.txt', note: '' }, { name: '~$a_2026-08.csv', note: '' }],
    folders: [],
  });
});

test('listSkippedItems: 自分自身の ID は出さない（名前が同じでも ID が違えば出す）', () => {
  const entries = [entry('集計ツール', g.GOOGLE_SHEET_MIME, 'SELF'), entry('集計ツール', g.GOOGLE_SHEET_MIME, 'OTHER')];
  assert.deepEqual(g.listSkippedItems(entries, [], 'SELF', []).files, [{ name: '集計ツール', note: g.GOOGLE_SHEET_NOTE }]);
});

test('listSkippedItems: Google 形式の note、最後に空白の付いた名前、X.CSV は読む側、サブフォルダの並び', () => {
  const entries = [entry('2026-10', g.GOOGLE_SHEET_MIME), entry('ショートカット', 'application/vnd.google-apps.shortcut'),
    entry('x.csv '), entry('X.CSV')];
  const names = lib.ListCsvFiles(entries.map((e) => e.name));
  assert.deepEqual(names, ['X.CSV']);
  assert.deepEqual(g.listSkippedItems(entries, names, 'SELF', ['2026-09', '2026-08', 'B', 'a']), {
    files: [
      { name: '2026-10', note: 'CSV が Google スプレッドシートに変わっている可能性があります' },
      { name: 'x.csv ', note: '' },
      { name: 'ショートカット', note: 'Google 形式のファイル' },
    ],
    folders: ['2026-08', '2026-09', 'B', 'a'],
  });
});

test('listSkippedItems: 0 件', () => {
  assert.deepEqual(g.listSkippedItems([entry('a.csv')], ['a.csv'], 'SELF', []), { files: [], folders: [] });
});

// ---- formatSkippedForMessage ----
test('formatSkippedForMessage: 0 件なら空、ファイルだけ・フォルダだけ・両方', () => {
  assert.equal(g.formatSkippedForMessage({ files: [], folders: [] }), '');
  assert.equal(g.formatSkippedForMessage({ files: [{ name: 'memo.txt', note: '' }, { name: '~$a.csv', note: '' }], folders: [] }),
    '読まなかったファイル: 2 件（memo.txt、~$a.csv）');
  assert.equal(g.formatSkippedForMessage({ files: [], folders: ['2026-09'] }), 'サブフォルダは読みません: 1 件（2026-09）');
  assert.equal(g.formatSkippedForMessage({ files: [{ name: 'memo.txt', note: '' }], folders: ['2026-09', '2026-10'] }),
    '読まなかったファイル: 1 件（memo.txt）\nサブフォルダは読みません: 2 件（2026-09、2026-10）');
});

test('formatSkippedForMessage: 11 件以上は 10 件と「ほか {n} 件」、Google スプレッドシートの行を別に出す', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ name: 'f' + String(i).padStart(2, '0'), note: i === 11 ? g.GOOGLE_SHEET_NOTE : '' }));
  assert.equal(g.formatSkippedForMessage({ files, folders: [] }),
    '読まなかったファイル: 12 件（f00、f01、f02、f03、f04、f05、f06、f07、f08、f09、ほか 2 件）\n' +
    'CSV が Google スプレッドシートに変わっている可能性があります: f11');
});

// ---- findReplacementCharLine ----
test('findReplacementCharLine: U+FFFD がなければ 0、あれば最初のものの行', () => {
  assert.equal(g.findReplacementCharLine('a,b\n1,2\n'), 0);
  assert.equal(g.findReplacementCharLine('�,b\n'), 1);
  assert.equal(g.findReplacementCharLine('a\nb\nc�\n'), 3);
  assert.equal(g.findReplacementCharLine('a\r\nb\r\nc�'), 3); // CRLF を 2 行と数えない
  assert.equal(g.findReplacementCharLine('a\rb\rc�'), 3);
  assert.equal(g.findReplacementCharLine('a,"x\ny"\nb�'), 3); // 引用符の中の改行も数える
  assert.equal(g.findReplacementCharLine('a\n�\n�'), 2);
  assert.equal(g.findReplacementCharLine('﻿a\nb�'), 2); // 先頭の BOM は行に影響しない
});

// ---- mergeReadFailures ----
const rep = (file, extra = {}) => Object.assign({ file, encoding: 'UTF-8', dataRows: 1, usedRows: 1, removed: 0 }, extra);
const failed = (file) => ({ file, encoding: '-', dataRows: 0, usedRows: 0, removed: 0 });

test('mergeReadFailures: 失敗がなければ result をそのまま（reports は names の順）', () => {
  const result = { errors: [], reports: [rep('a.csv'), rep('b.csv')], details: [1], summary: [2], monthly: [3] };
  assert.deepEqual(g.mergeReadFailures(['a.csv', 'b.csv'], result, []), result);
});

test('mergeReadFailures: 先頭・途中・最後のファイルが失敗。ファイル名の順に並び、（全体）は最後、失敗の reports は - 0 0 0', () => {
  const names = ['a.csv', 'b.csv', 'c.csv', 'd.csv', 'e.csv'];
  const result = {
    errors: [{ file: 'b.csv', line: 3, message: 'B3' }, { file: 'd.csv', line: 2, message: 'D2' }, { file: '（全体）', line: 0, message: '全体' }],
    reports: [rep('b.csv'), rep('d.csv')],
  };
  const failures = [
    { file: 'e.csv', line: 0, message: 'E' }, { file: 'a.csv', line: 0, message: 'A' }, { file: 'c.csv', line: 0, message: 'C' },
  ];
  const m = g.mergeReadFailures(names, result, failures);
  assert.deepEqual(m.errors.map((e) => e.message), ['A', 'B3', 'C', 'D2', 'E', '全体']);
  assert.deepEqual(m.reports, [failed('a.csv'), rep('b.csv'), failed('c.csv'), rep('d.csv'), failed('e.csv')]);
  assert.equal(m.summary, undefined);
});

test('mergeReadFailures: 全部失敗なら noData でもエラーになる', () => {
  const m = g.mergeReadFailures(['a.csv'], { errors: [], reports: [], noData: true }, [{ file: 'a.csv', line: 0, message: 'A' }]);
  assert.equal(m.errors.length, 1);
  assert.equal(m.noData, undefined);
});

test('mergeReadFailures: U+FFFD の失敗があるファイルでは lib.js のエラーを捨て、他のファイルのエラーは残す', () => {
  const result = {
    errors: [{ file: 'a.csv', line: 1, message: '見出しにありません' }, { file: 'a.csv', line: 4, message: 'x' }, { file: 'b.csv', line: 2, message: 'B2' }],
    reports: [rep('a.csv'), rep('b.csv')],
  };
  const m = g.mergeReadFailures(['a.csv', 'b.csv'], result, [{ file: 'a.csv', line: 3, message: g.DECODE_FAILURE_MESSAGE }]);
  assert.deepEqual(m.errors, [{ file: 'a.csv', line: 3, message: g.DECODE_FAILURE_MESSAGE }, { file: 'b.csv', line: 2, message: 'B2' }]);
  assert.deepEqual(m.reports, [failed('a.csv'), rep('b.csv')]);
});

test('mergeReadFailures: 件数が合わないときは例外', () => {
  const ok = { errors: [], reports: [rep('a.csv')] };
  assert.throws(() => g.mergeReadFailures(['a.csv'], ok, [{ file: 'z.csv', line: 0, message: 'Z' }]), /mergeReadFailures/);
  assert.throws(() => g.mergeReadFailures(['a.csv', 'b.csv'], { errors: [], reports: [] },
    [{ file: 'a.csv', line: 0, message: 'A' }, { file: 'a.csv', line: 0, message: 'A' }]), /同じファイルの失敗/);
  assert.throws(() => g.mergeReadFailures(['a.csv'], { errors: [{ file: 'q.csv', line: 1, message: 'Q' }], reports: [rep('a.csv')] }, []), /mergeReadFailures/);
  assert.throws(() => g.mergeReadFailures(['a.csv', 'b.csv'], { errors: [], reports: [rep('a.csv')] }, []), /取り込み結果の数/);
});

// ---- isOwnOutputSheet ----
test('isOwnOutputSheet: 見出しが一致・前後の空白だけ違う・列が多い少ない・空・別の名前', () => {
  assert.equal(g.isOwnOutputSheet('集計', ['年月', '商品', '数量', '金額']), true);
  assert.equal(g.isOwnOutputSheet('集計', [' 年月', '商品　', '数量', '金額 ']), true);
  assert.equal(g.isOwnOutputSheet('集計', ['年月', '商品', '数量', '金額', '']), false);
  assert.equal(g.isOwnOutputSheet('集計', ['年月', '商品', '数量']), false);
  assert.equal(g.isOwnOutputSheet('集計', []), false);
  assert.equal(g.isOwnOutputSheet('集計', ['']), false);
  assert.equal(g.isOwnOutputSheet('設定', ['キー', '値', '説明']), false);
  assert.equal(g.isOwnOutputSheet('エラー', ['ファイル', '行', '内容']), true);
});

// ---- toSheetText ----
test('toSheetText: = + - @ で始まる文字に \' を付ける。guard が偽なら付けない', () => {
  for (const v of ['=SUM(1,2)', '+81', '-1', '@x']) {
    assert.equal(g.toSheetText(v, true), "'" + v);
    assert.equal(g.toSheetText(v, false), v);
  }
});

test('toSheetText: それ以外は変えない（全角の ＝ は Sheets が数式にしない見込み。仮説）。数値はそのまま', () => {
  for (const v of ['0012', '商品A', '', 'a=b', '＝1+1', ' =1']) assert.equal(g.toSheetText(v, true), v);
  assert.equal(g.toSheetText(-980, true), -980);
});

// ---- numberFormatFor ----
test('numberFormatFor: 整数だけ・小数あり・負の数・空', () => {
  assert.equal(g.numberFormatFor([1, 2, 3]), '#,##0');
  assert.equal(g.numberFormatFor([1, 2.5]), '#,##0.00');
  assert.equal(g.numberFormatFor([-980, -1]), '#,##0');
  assert.equal(g.numberFormatFor([-0.25]), '#,##0.00');
  assert.equal(g.numberFormatFor([]), '#,##0');
});

// ---- build*Values ----
test('buildSummaryValues・buildMonthlyValues・buildDetailValues: 見出しと並び、合計行、文字の列に toSheetText', () => {
  assert.deepEqual(g.buildSummaryValues([{ ym: '2026-10', product: '=SUM(1,2)', quantity: 1, amount: 100 }], true),
    [['年月', '商品', '数量', '金額'], ['2026-10', "'=SUM(1,2)", 1, 100]]);
  assert.deepEqual(g.buildMonthlyValues([{ ym: '2026-09', quantity: 2, amount: 300.5 }, { ym: '2026-10', quantity: -1, amount: -980 }], true),
    [['年月', '数量', '金額'], ['2026-09', 2, 300.5], ['2026-10', -1, -980], ['合計', 1, -679.5]]);
  assert.deepEqual(g.buildDetailValues([{ ym: '2026-10', ymd: '2026-10-01', orderId: '-A1', product: '0012', quantity: 1, amount: 500, file: 'c.csv', line: 6 }], true),
    [['年月', '日付', '注文番号', '商品', '数量', '金額', '元ファイル', '元の行'], ['2026-10', '2026-10-01', "'-A1", '0012', 1, 500, 'c.csv', 6]]);
});

test('buildReportValues: 表の下に実行日時・フォルダ・読まなかったファイル・サブフォルダ（0 件でも行を出す）', () => {
  const values = g.buildReportValues([rep('a.csv', { encoding: 'Shift_JIS', dataRows: 5, usedRows: 4, removed: 1 })],
    { runAt: '2026-10-15 14:03:21', folderLabel: 'input（ID: 1AbCdEfGhIjK）', skipped: { files: [{ name: 'memo.txt', note: '' }, { name: '2026-10', note: g.GOOGLE_SHEET_NOTE }], folders: [] } }, true);
  assert.deepEqual(values, [
    ['ファイル', '文字コード', 'データ行', '使った行', '重複で除いた行'],
    ['a.csv', 'Shift_JIS', 5, 4, 1],
    ['', '', '', '', ''],
    ['実行日時', '2026-10-15 14:03:21', '', '', ''],
    ['フォルダ', 'input（ID: 1AbCdEfGhIjK）', '', '', ''],
    ['読まなかったファイル', '2 件', '', '', ''],
    ['', 'memo.txt', '', '', ''],
    ['', '2026-10', g.GOOGLE_SHEET_NOTE, '', ''],
    ['サブフォルダ（読みません）', '0 件', '', '', ''],
  ]);
});

test('buildErrorValues: 見出しと、ファイル・行・内容。表の下に 1 行空けて実行日時', () => {
  assert.deepEqual(g.buildErrorValues([{ file: 'a.csv', line: 0, message: 'ファイルを読めません: x' }], '2026-10-15 14:03:21', true),
    [['ファイル', '行', '内容'], ['a.csv', 0, 'ファイルを読めません: x'], ['', '', ''], ['実行日時', '2026-10-15 14:03:21', '']]);
});

// ---- buildSuccessMessage ----
test('buildSuccessMessage: 実行日時が入り、読まなかったものがなければ追加の行がない', () => {
  const base = { runAt: '2026-10-15 14:03:21', csvCount: 4, detailRows: 13, removed: 2 };
  assert.equal(g.buildSuccessMessage(Object.assign({ skipped: { files: [], folders: [] } }, base)),
    '集計しました（2026-10-15 14:03:21）。CSV 4 件、明細 13 行（重複で除いた行 2）。「集計」「月別合計」「明細」「取り込み結果」シートを作り直しました。');
  const withSkipped = g.buildSuccessMessage(Object.assign({ skipped: { files: [{ name: 'memo.txt', note: '' }], folders: ['2026-09'] } }, base));
  assert.deepEqual(withSkipped.split('\n').slice(1), ['読まなかったファイル: 1 件（memo.txt）', 'サブフォルダは読みません: 1 件（2026-09）']);
});

// ---- 0x8160（〜）の確認（仕様 4.2。tester が確かめる事実をここで固定する） ----
// Node.js 22 で実行した結果: new TextDecoder('shift_jis').decode(new Uint8Array([0x81, 0x60])) は U+FF5E（全角チルダ）。
// VBA 版（CP932）・Java の windows-31j と同じ文字。Java の Shift_JIS は U+301C（波ダッシュ）になる（調査 2）。
test('Node.js の shift_jis は 0x81 0x60 を U+FF5E にする（モックで windows-31j として使ってよいことの確認）', () => {
  const s = new TextDecoder('shift_jis').decode(new Uint8Array([0x81, 0x60]));
  assert.equal(s.codePointAt(0).toString(16), 'ff5e');
});

// =====================================================================
// tester（2026-10-15）が足した境目の観点。docs/reviews/gas-csv-aggregator-test.md
// =====================================================================
test('tester: extractFolderId: 末尾の /、id の後ろの別のパラメーター、folders の後ろの resourcekey、grid= を id= と取り違えない', () => {
  const id = '1AbCdEfGhIjK_lm-n';
  assert.equal(g.extractFolderId('https://drive.google.com/drive/folders/' + id + '/'), id);
  assert.equal(g.extractFolderId('https://drive.google.com/drive/folders/' + id + '?resourcekey=0-abc&usp=sharing'), id);
  assert.equal(g.extractFolderId('https://drive.google.com/open?id=' + id + '&authuser=0'), id);
  assert.equal(g.extractFolderId('https://drive.google.com/drive/mobile/folders/' + id), id);
  assert.equal(g.extractFolderId('https://example.com/view?grid=abcdefghijkl'), '');
  assert.equal(g.extractFolderId('https://docs.google.com/spreadsheets/d/' + id + '/edit'), '');
  assert.equal(g.extractFolderId('abcdefghij'), 'abcdefghij'); // 10 文字ちょうどは ID とみなす（9 文字は空: 上のテスト）
  assert.equal(g.extractFolderId(12345678901), '12345678901'); // セルが数値でも文字にして読む
});

test('tester: findReplacementCharLine: 空・U+FFFD だけ・CR が 2 つ続く・LF の後ろの CR（2 行と数える）・最後の文字', () => {
  assert.equal(g.findReplacementCharLine(''), 0);
  assert.equal(g.findReplacementCharLine('�'), 1);
  assert.equal(g.findReplacementCharLine('a\r\r�'), 3);
  assert.equal(g.findReplacementCharLine('a\n\r�'), 3); // LF CR は CRLF ではないので 2 つの改行
  assert.equal(g.findReplacementCharLine('a\r\n\r\n\r\n'), 0);
  assert.equal(g.findReplacementCharLine('a\nb\nc�'), 3);
});

test('tester: mergeReadFailures: 2 つのファイルの U+FFFD と、別のファイルの lib.js のエラーと（全体）が混ざっても、件数が合い、順番が崩れない', () => {
  const result = {
    errors: [
      { file: 'a.csv', line: 1, message: '見出しにありません' },
      { file: 'b.csv', line: 2, message: 'B2' },
      { file: 'c.csv', line: 5, message: 'C5' },
      { file: 'c.csv', line: 6, message: 'C6' },
      { file: '（全体）', line: 0, message: '全体' },
    ],
    reports: ['a.csv', 'b.csv', 'c.csv'].map((f) => ({ file: f, encoding: 'UTF-8', dataRows: 1, usedRows: 1, removed: 0 })),
  };
  const failures = [{ file: 'c.csv', line: 9, message: g.DECODE_FAILURE_MESSAGE }, { file: 'a.csv', line: 1, message: g.DECODE_FAILURE_MESSAGE }];
  const m = g.mergeReadFailures(['a.csv', 'b.csv', 'c.csv'], result, failures);
  assert.deepEqual(m.errors.map((e) => [e.file, e.line, e.message === g.DECODE_FAILURE_MESSAGE ? 'FFFD' : e.message]),
    [['a.csv', 1, 'FFFD'], ['b.csv', 2, 'B2'], ['c.csv', 9, 'FFFD'], ['（全体）', 0, '全体']]);
  assert.deepEqual(m.reports.map((r) => r.encoding), ['-', 'UTF-8', '-']);
});

test('tester: isOwnOutputSheet: 見出しの右に空のセルが続く（getLastColumn が 1 行目より広い）・null・数値の見出しは違うとする', () => {
  assert.equal(g.isOwnOutputSheet('集計', ['年月', '商品', '数量', '金額', '', '']), false);
  assert.equal(g.isOwnOutputSheet('集計', ['年月', null, '数量', '金額']), false);
  assert.equal(g.isOwnOutputSheet('集計', null), false);
  assert.equal(g.isOwnOutputSheet('月別合計', ['年月', 2026, '金額']), false);
  assert.equal(g.isOwnOutputSheet('集計（作成中）', ['年月', '商品', '数量', '金額']), false);
});

test('tester: toSheetText: 全角の ＋ － ＠、先頭が \' の値、= だけ、改行で始まる値、文字でない値', () => {
  for (const v of ['＋81', '－1', '＠x', "'abc", '\n=1']) assert.equal(g.toSheetText(v, true), v);
  assert.equal(g.toSheetText('=', true), "'=");
  assert.equal(g.toSheetText('-', true), "'-");
  for (const v of [null, undefined, true, 0]) assert.equal(g.toSheetText(v, true), v);
});

test('tester: buildReportValues: guard が偽なら表の下にも \' を付けない。サブフォルダとファイルの両方が並ぶ', () => {
  const values = g.buildReportValues([], { runAt: 't', folderLabel: '=f（ID: x）', skipped: { files: [{ name: '@a', note: '' }], folders: ['+s'] } }, false);
  assert.deepEqual(values.slice(1).map((r) => r.slice(0, 2)), [
    ['', ''], ['実行日時', 't'], ['フォルダ', '=f（ID: x）'], ['読まなかったファイル', '1 件'], ['', '@a'], ['サブフォルダ（読みません）', '1 件'], ['', '+s'],
  ]);
  assert.ok(values.every((r) => r.length === 5));
});
