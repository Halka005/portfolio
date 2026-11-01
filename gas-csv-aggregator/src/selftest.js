/**
 * 自己テスト（開発用。**納品物には入れない**）。仕様: docs/specs/selftest.md（版 5）
 * テスト専用のスプレッドシート（名前が「自己テスト」で始まる）で、メニュー「CSV 集計」→「自己テスト（開発用）」から動かす。
 * ドライブに上げた共通テストケース（excel-csv-aggregator/tests/cases）を本番の処理（aggregateWith_）に流し、
 * 結果を「自己テスト」シートに ○ / × / 未実施で書く。「設定」シートは読まない・書かない。ドライブは読むだけ。
 *
 * 上に純粋関数（Node.js から require して単体テストする）、下に GAS の処理。
 * 最上位の var は定数だけにする（コードの指紋に入るため。仕様 8.3）。最上位で他のファイルの名前を使わない。
 * 期待値と ○ / × の比べ方には、本番の関数・定数を使わない（仕様 4.5）。自己テスト側に文字で書き（SELFTEST_OUTPUT_SHEETS・
 * SELFTEST_DECODE_MESSAGE・SELFTEST_FOREIGN_MESSAGE）、自己テスト側の関数（selfTestGuardText_）で作る。本番と同じかは
 * tests/selftest.test.js で確かめる。例外は C10 の準備の isOwnOutputSheet だけ（4.5 の表）。
 */

var SELFTEST_VERSION = '2026-10-19';
var SELFTEST_SHEET = '自己テスト';
var SELFTEST_WORK_SHEET = '自己テスト（作業用）';
var SELFTEST_SETTINGS_SHEET = '自己テスト設定';
var SELFTEST_NAME_PREFIX = '自己テスト';
var SELFTEST_LIMIT_MS = 4 * 60 * 1000;
var SELFTEST_RESUME_MS = 60 * 60 * 1000;
var SELFTEST_HEADERS = ['番号', '区分', '項目', '結果', '詳細', '秒', '回'];
var SELFTEST_COLOR_HEADER = '#e0e0e0';
var SELFTEST_COLOR_INPUT = '#fff8c5';
var SELFTEST_COLOR_RED = '#c62828';
var SELFTEST_GOOGLE_MIME_PREFIX = 'application/vnd.google-apps.';
var SELFTEST_NAME_MESSAGE = 'このスプレッドシートの名前が「自己テスト」で始まっていないので、止めました。自己テストは、本番のデータを消さないように、テスト専用のスプレッドシートでだけ動きます。新しいスプレッドシートを作り、名前を「自己テスト_CSV集計」のようにしてから実行してください。';
var SELFTEST_MANUAL_STOP_MESSAGE = '「自己テスト」シートの M01・M02 に書き込みがあるので、止めました。書き込みを別に控えてから、「自己テスト」シートを消して、もう一度押してください。';
var SELFTEST_M03_TEXT = 'ここには書かないでください。確かめたものは、README 9 章の行ごとに、何を見てどうだったかを別に送ってください';
var SELFTEST_NOT_YET = '時間: まだ実施していません';
var SELFTEST_TIME_UP = '時間: 時間が足りないので、ここで止めました';
var SELFTEST_C01_FAILED = '実施できません: C01 の集計が成功しなかったため';
// 4.3 の期待値の文字の列（1 から）。本番の OUTPUT_LAYOUT を使わずに書く（本番の誤りを期待値に移さないため）
var SELFTEST_TEXT_COLS = { '集計': [1, 2], '月別合計': [1], '明細': [1, 2, 3, 4, 7], '取り込み結果': [1, 2], 'エラー': [1, 3] };
var SELFTEST_FOUR = ['集計', '月別合計', '明細', '取り込み結果'];
// 4.5: 本番の OUTPUT_SHEETS・DECODE_FAILURE_MESSAGE・foreignSheetMessage('明細', []) を使わずに書く。本番と同じかは tests/selftest.test.js で確かめる
var SELFTEST_OUTPUT_SHEETS = ['集計', '月別合計', '明細', '取り込み結果', 'エラー'];
var SELFTEST_DECODE_MESSAGE = '文字コードの変換で読めない文字がありました。ENCODING の設定と、ファイルの文字コードを確かめてください';
var SELFTEST_FOREIGN_MESSAGE = '「明細」シートは、このツールが作ったものではないようです（1 行目の見出しが違います）。シートの名前を変えてから、もう一度実行してください。';
var SELFTEST_EXPECTED_FILES = { '集計': 'summary.csv', '月別合計': 'monthly.csv', '明細': 'details.csv', '取り込み結果': 'files.csv' };
var SELFTEST_FORMULA_VALUES = ['=1+1', '+81', '-x', '@x', '＝1+1'];

// ケースごとのファイルの名前とバイト数（4.4）。リポジトリの実物と一致することを tests/selftest.test.js で確かめる
var CASE_FILES = {
  '01-basic': {
    'input/a_2026-08.csv': 326,
    'input/b_2026-09.csv': 300,
    'input/c_2026-09-to-10.csv': 305,
    'input/d_2026-09-crlf.csv': 115,
    'input/memo.txt': 60,
    'input/~$a_2026-08.csv': 3,
    'expected/details.csv': 1120,
    'expected/files.csv': 220,
    'expected/monthly.csv': 91,
    'expected/summary.csv': 517,
    'settings.json': 199,
  },
  '02-errors': {
    'input/v_utf16.csv': 96,
    'input/w_unclosed-quote.csv': 164,
    'input/x_missing-column.csv': 73,
    'input/y_bad-values.csv': 222,
    'input/z_empty.csv': 0,
    'expected/errors.csv': 725,
    'settings.json': 199,
  },
  '03-no-dedupe': {
    'input/p_week1.csv': 126,
    'input/q_week1-again.csv': 127,
    'expected/details.csv': 376,
    'expected/files.csv': 137,
    'expected/monthly.csv': 58,
    'expected/summary.csv': 123,
    'settings.json': 182,
  },
  '04-unclosed-one-file': {
    'input/a_ok.csv': 68,
    'input/b_unclosed-last-line.csv': 92,
    'input/c_header-only.csv': 35,
    'input/d_mixed-newlines.csv': 127,
    'expected/errors.csv': 223,
    'settings.json': 187,
  },
  '05-stray-quotes': {
    'input/a_example1-text-after-quote.csv': 185,
    'input/b_example2-quote-at-line-end.csv': 158,
    'input/c_example3-middle-column.csv': 86,
    'input/d_example4-same-column.csv': 89,
    'input/e_multiline-note-ok.csv': 155,
    'expected/errors.csv': 1971,
    'settings.json': 209,
  },
  '06-sjis-fixed-decimal': {
    'input/a_sjis.csv': 79,
    'input/b_ascii-only.csv': 68,
    'expected/details.csv': 233,
    'expected/files.csv': 143,
    'expected/monthly.csv': 62,
    'expected/summary.csv': 88,
    'settings.json': 199,
  },
};

// 実行の順（5.1）。cases は使うケース（4.4）、group は組（6.6）、by は別の項目の関数の中で記録する項目
var SELFTEST_PLAN = [
  { id: 'C01', kind: '判定', title: 'ケース 01-basic を初期値で集計。4 シートが expected と一致', run: selfTestC01_, group: 'G1', cases: ['01-basic'] },
  { id: 'C02', kind: '判定', title: '01: ①・㈱ が化けない（windows-31j）', run: selfTestC02_, group: 'G1', cases: ['01-basic'] },
  { id: 'C03', kind: '判定', title: '01: =SUM(1,2) が数式にならない（数式の確認）', run: selfTestC03_, group: 'G1', cases: ['01-basic'] },
  { id: 'C04', kind: '判定', title: '01: 読まなかったファイル（memo.txt・~$a_2026-08.csv）', run: selfTestC04_, group: 'G1', cases: ['01-basic'] },
  { id: 'C05', kind: '判定', title: '01: 再実行で同じ結果（再実行）', run: selfTestC05_, group: 'G1', cases: ['01-basic'] },
  { id: 'C06', kind: '記録', title: '01: 他のシートからの =集計!D2 が #REF! になるか', run: null, by: 'C05', group: 'G1', cases: ['01-basic'] },
  { id: 'C07', kind: '判定', title: '01: 元の CSV を変えない', run: selfTestC07_, group: 'G1', cases: ['01-basic'] },
  { id: 'C08', kind: '判定', title: "01: SJIS_CHARSET を 'Shift_JIS' にすると変換のエラーになる（変換の確認）", run: selfTestC08_, group: '', cases: ['01-basic'] },
  { id: 'C09', kind: '判定', title: '01: ENCODING = UTF-8 では a_2026-08.csv が行 1 の変換のエラー', run: selfTestC09_, group: '', cases: ['01-basic'] },
  { id: 'C10', kind: '判定', title: '他人のシートを守る（空の「明細」）', run: selfTestC10_, group: '', cases: ['01-basic'] },
  { id: 'C11', kind: '判定', title: '02-errors（前の集計のシートが消える）', run: selfTestC11_, group: '', cases: ['01-basic', '02-errors'] },
  { id: 'C12', kind: '判定', title: '03-no-dedupe', run: selfTestC12_, group: '', cases: ['03-no-dedupe'] },
  { id: 'C13', kind: '判定', title: '03: CSV_FOLDER が前後に空白のある …/folders/{ID}?usp=sharing の形（URL の形）', run: selfTestC13_, group: '', cases: ['03-no-dedupe'] },
  { id: 'C14', kind: '判定', title: '04-unclosed-one-file', run: selfTestC14_, group: '', cases: ['04-unclosed-one-file'] },
  { id: 'C15', kind: '判定', title: '05-stray-quotes', run: selfTestC15_, group: '', cases: ['05-stray-quotes'] },
  { id: 'C16', kind: '判定', title: '05: QUOTE_CHECK = FALSE', run: selfTestC16_, group: '', cases: ['05-stray-quotes'] },
  { id: 'C17', kind: '判定', title: '05: QUOTE_CHECK の行なし・空白だけ', run: selfTestC17_, group: 'G2', cases: ['05-stray-quotes'] },
  { id: 'C18', kind: '判定', title: '05: QUOTE_CHECK = abc で止まり、シートを変えない', run: selfTestC18_, group: 'G2', cases: ['05-stray-quotes'] },
  { id: 'C19', kind: '判定', title: '06-sjis-fixed-decimal（金額が小数 2 桁の書式）', run: selfTestC19_, group: '', cases: ['06-sjis-fixed-decimal'] },
  { id: 'C20', kind: '判定', title: '数式の 5 つの値（=1+1・+81・-x・@x・＝1+1。数式の確認）', run: selfTestC20_, group: '', cases: [] },
  { id: 'C21', kind: '記録', title: 'FORMULA_GUARD を false にしても数式にならないか（数式の確認の結果の扱い）', run: selfTestC21_, group: '', cases: [] },
];

// 手で確認（5.4）。M01 の {N} は期待値の明細から数えた最後の行の番号
var SELFTEST_MANUAL = [
  { id: 'M01', title: '本番のメニュー（README の手順）: 別のスプレッドシート「本番確認_CSV集計」に、自己テストと同じ ZIP の main.js・lib.js・gas-lib.js・appsscript.json だけを貼る。E 列に (1) メニューの項目 (2) 出た文の 1 行目 (3) 「明細」の最後の行の番号（{N}）(4) シートの並び (5) ZIP をダウンロードした日' },
  { id: 'M02', title: '承認画面の文（自己テストのときと M01 のとき）。E 列に書き写すか、スクリーンショットを添える。ドライブが「表示」だけで「編集」「削除」がないか。自分のメールアドレスと名前は書かない' },
  { id: 'M03', title: '任意の手で確認（手順は README 9 章）: 承認の直後のメニュー／Workspace の承認／承認の取り消しの画面／2 つのタブで同時に実行／同じ名前の CSV・サブフォルダ・変換された CSV・ショートカット／1 万行・5 万行の処理時間／〜 の文字' },
];

// コードの指紋に入れる名前（8.3）。main.js・lib.js・gas-lib.js・selftest.js の最上位の関数と var の全部を、名前の順に。
// 手で数えない。tests/selftest.test.js がファイルの中身とちょうど一致するかを確かめる
var SELFTEST_FINGERPRINT_FUNCS = [
  'AggregateByMonth',
  'AggregateByMonthProduct',
  'AggregateFiles',
  'CleanFolderPath',
  'DedupeRecords',
  'DetectEncoding',
  'FindColumns',
  'HasUtf16Bom',
  'IsValidUtf8',
  'ListCsvFiles',
  'NormalizeRows',
  'ParseCsv',
  'ParseDate',
  'ParseNumber',
  'QuoteCommaMessage',
  'QuoteTailMessage',
  'StripBom',
  'TrimText',
  'aggregateFolder',
  'aggregateLocked_',
  'aggregateWith_',
  'buildDetailValues',
  'buildErrorValues',
  'buildMonthlyValues',
  'buildReportValues',
  'buildSelfTestValues',
  'buildSuccessMessage',
  'buildSummaryValues',
  'checkQuoteCommas_',
  'checkUploadedFiles',
  'codeFingerprint',
  'columnLetter',
  'compareBinary_',
  'compareCodeUnits_',
  'compareTables',
  'countChar_',
  'daysInMonth_',
  'decodeBytes_',
  'dedupeKey_',
  'deleteSheetsQuietly_',
  'dropDown_',
  'expectedWithGuard',
  'extractFolderId',
  'findDuplicateNames',
  'findForeignOutputSheet_',
  'findReplacementCharLine',
  'fingerprintSources',
  'foreignSheetMessage',
  'foreignSheetMessage_',
  'formatDiffs',
  'formatSkippedForMessage',
  'googleFormatMessage',
  'hasOwn_',
  'headerRow_',
  'isBlankRecord_',
  'isLeapYear_',
  'isOwnOutputSheet',
  'isQuoteEnd_',
  'isSpaceChar_',
  'itemResult',
  'joinNamesForMessage_',
  'listSkippedItems',
  'makeDecoder_',
  'mergeReadFailures',
  'messageOf_',
  'numberError_',
  'numberFormatFor',
  'onOpen',
  'overallResult',
  'pad2_',
  'quoteColumnName_',
  'readSettings',
  'rebuiltCheck',
  'replaceAll_',
  'replaceOutputSheets_',
  'resumePoint',
  'runAggregation',
  'runSelfTest',
  'selfTestC01_',
  'selfTestC02_',
  'selfTestC03_',
  'selfTestC04_',
  'selfTestC05_',
  'selfTestC07_',
  'selfTestC08_',
  'selfTestC09_',
  'selfTestC10_',
  'selfTestC11_',
  'selfTestC12_',
  'selfTestC13_',
  'selfTestC14_',
  'selfTestC15_',
  'selfTestC16_',
  'selfTestC17_',
  'selfTestC18_',
  'selfTestC19_',
  'selfTestC20_',
  'selfTestC21_',
  'selfTestCase_',
  'selfTestCheckCase_',
  'selfTestCheckFour_',
  'selfTestCheckSet_',
  'selfTestCheckStatus_',
  'selfTestChildFolder_',
  'selfTestCodeOf_',
  'selfTestCreateSettingsSheet_',
  'selfTestDetailLastRow_',
  'selfTestDropWorkSheet_',
  'selfTestErrorCase_',
  'selfTestExpectedRaw_',
  'selfTestExpected_',
  'selfTestFile_',
  'selfTestFinalMessage_',
  'selfTestFindCases_',
  'selfTestFinish_',
  'selfTestFormulaRows_',
  'selfTestFourCase_',
  'selfTestFour_',
  'selfTestGroupNames_',
  'selfTestGuardText_',
  'selfTestHasOwn_',
  'selfTestInfoRows_',
  'selfTestInputSnapshot_',
  'selfTestItemContext_',
  'selfTestLocked_',
  'selfTestMessage_',
  'selfTestMinutes_',
  'selfTestOutputs_',
  'selfTestOverall_',
  'selfTestParseConstants_',
  'selfTestParseRestarts_',
  'selfTestParseRuns_',
  'selfTestPrepareSheet_',
  'selfTestReason_',
  'selfTestRestartText_',
  'selfTestRunCase_',
  'selfTestRunItem_',
  'selfTestSafeText_',
  'selfTestSeconds_',
  'selfTestSetWithRecords_',
  'selfTestSettingValue_',
  'selfTestSettingsRows_',
  'selfTestSheetById_',
  'selfTestSheetText_',
  'selfTestStoppedCount_',
  'selfTestTablePart_',
  'selfTestValues_',
  'selfTestWorkSheet_',
  'selfTestWrite_',
  'selfTest_',
  'settingText_',
  'setupSettings',
  'sortErrorsByLine_',
  'stopped_',
  'styleHeader_',
  'toAggregateSettings',
  'toHalfWidthDigits_',
  'toSheetText',
  'validateSettings',
  'writeTable_',
];
var SELFTEST_FINGERPRINT_VARS = [
  'CASE_FILES',
  'COLOR_HEADER',
  'COLOR_INPUT',
  'DECODE_FAILURE_MESSAGE',
  'DEFAULT_SETTINGS',
  'ENCODING_AUTO',
  'ENCODING_SJIS',
  'ENCODING_UTF16',
  'ENCODING_UTF8',
  'ENCODING_UTF8_BOM',
  'FORMULA_GUARD',
  'GOOGLE_FORMAT_MESSAGE',
  'GOOGLE_FORMAT_NOTE',
  'GOOGLE_MIME_PREFIX',
  'GOOGLE_SHEET_MIME',
  'GOOGLE_SHEET_NOTE',
  'LOCK_WAIT_MS',
  'MAX_DETAIL_ROWS',
  'NOT_CHANGED',
  'OUTPUT_HEADERS',
  'OUTPUT_LAYOUT',
  'OUTPUT_SHEETS',
  'OVERALL_FILE_NAME',
  'QUOTE_COMMA_MESSAGE',
  'QUOTE_TAIL_MESSAGE',
  'READ_LIMIT_MS',
  'SELFTEST_C01_FAILED',
  'SELFTEST_COLOR_HEADER',
  'SELFTEST_COLOR_INPUT',
  'SELFTEST_COLOR_RED',
  'SELFTEST_DECODE_MESSAGE',
  'SELFTEST_EXPECTED_FILES',
  'SELFTEST_FINGERPRINT_FUNCS',
  'SELFTEST_FINGERPRINT_VARS',
  'SELFTEST_FOREIGN_MESSAGE',
  'SELFTEST_FORMULA_VALUES',
  'SELFTEST_FOUR',
  'SELFTEST_GOOGLE_MIME_PREFIX',
  'SELFTEST_HEADERS',
  'SELFTEST_LIMIT_MS',
  'SELFTEST_M03_TEXT',
  'SELFTEST_MANUAL',
  'SELFTEST_MANUAL_STOP_MESSAGE',
  'SELFTEST_NAME_MESSAGE',
  'SELFTEST_NAME_PREFIX',
  'SELFTEST_NOT_YET',
  'SELFTEST_OUTPUT_SHEETS',
  'SELFTEST_PLAN',
  'SELFTEST_RESUME_MS',
  'SELFTEST_SETTINGS_SHEET',
  'SELFTEST_SHEET',
  'SELFTEST_TEXT_COLS',
  'SELFTEST_TIME_UP',
  'SELFTEST_VERSION',
  'SELFTEST_WORK_SHEET',
  'SETTINGS_MESSAGE_HEAD',
  'SHEET_SETTINGS',
  'SHORTCUT_MESSAGE',
  'SHORTCUT_MIME',
  'SJIS_CHARSET',
  'SKIPPED_MESSAGE_LIMIT',
  'UNCLOSED_QUOTE_MESSAGE',
  'UTF16_MESSAGE',
  'WORKING_SUFFIX',
  'WRITE_LIMIT_MS',
];

// ==================== 純粋関数 ====================

function selfTestHasOwn_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 1 → A、26 → Z、27 → AA */
function columnLetter(n) {
  var s = '';
  var x = n;
  while (x > 0) {
    var m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/**
 * 2 次元の文字の配列を比べる（4.3）。options: { name（diffs のセルの前に付ける）, guarded（守ったセルの '行,列' の集合。1 から） }
 * 守ったセルだけ、実際の値が ' 付き・' なしのどちらでも一致とする。守っていないセルは完全一致。
 * 戻り値: { expectedCount（期待値のセルの数）, compared（比べたセルの数）, diffs: [{ cell, expected, actual }], guardedWithQuote, guardedWithoutQuote }
 */
function compareTables(expected, actual, options) {
  var opts = options || {};
  var guarded = opts.guarded || {};
  var prefix = opts.name ? opts.name + ' ' : '';
  var exp = expected || [];
  var act = actual || [];
  var expectedCount = 0;
  exp.forEach(function (row) { expectedCount += row.length; });
  var diffs = [];
  var compared = 0;
  var withQuote = 0;
  var withoutQuote = 0;
  if (exp.length !== act.length) diffs.push({ cell: prefix + '行の数', expected: String(exp.length), actual: String(act.length) });
  var rows = Math.min(exp.length, act.length);
  for (var i = 0; i < rows; i++) {
    var e = exp[i];
    var a = act[i];
    if (e.length !== a.length) diffs.push({ cell: prefix + (i + 1) + ' 行目の列の数', expected: String(e.length), actual: String(a.length) });
    var cols = Math.min(e.length, a.length);
    for (var j = 0; j < cols; j++) {
      compared++;
      var ev = String(e[j]);
      var av = String(a[j]);
      if (selfTestHasOwn_(guarded, (i + 1) + ',' + (j + 1))) {
        if (av === ev) { withQuote++; continue; }
        if (ev.charAt(0) === "'" && av === ev.slice(1)) { withoutQuote++; continue; }
      } else if (av === ev) {
        continue;
      }
      diffs.push({ cell: prefix + columnLetter(j + 1) + (i + 1), expected: ev, actual: av });
    }
  }
  return { expectedCount: expectedCount, compared: compared, diffs: diffs, guardedWithQuote: withQuote, guardedWithoutQuote: withoutQuote };
}

/**
 * 詳細の文。3 か所まで並べ、残りは「ほか n か所」。1 か所は 120 文字まで。
 * diffs: [{ cell, expected, actual }] か [{ text }]
 */
function formatDiffs(diffs, limit) {
  var max = limit || 3;
  var oneLine = function (v) { return String(v).replace(/\r\n|\r|\n/g, '\\n'); };
  var shown = diffs.slice(0, max).map(function (d) {
    var s = d.text !== undefined ? oneLine(d.text) : d.cell + ': 期待「' + oneLine(d.expected) + '」実際「' + oneLine(d.actual) + '」';
    return s.length > 120 ? s.slice(0, 119) + '…' : s;
  });
  var text = shown.join('。');
  if (diffs.length > max) text += '。ほか ' + (diffs.length - max) + ' か所';
  return text;
}

/**
 * 項目の結果（5 章の冒頭）。checks: [{ name, ok, detail?, count?（既定 1。表は比べたセルの数）, diffs? }]
 * ○ は「確かめるはずの数 > 0」かつ「確かめた数 = 確かめるはずの数」かつ「違いが 0」のときだけ。
 * 戻り値: { result: '○' | '×' | '未実施', detail }
 */
function itemResult(expectedCount, checks) {
  var checked = 0;
  var failures = [];
  (checks || []).forEach(function (c) {
    checked += c.count === undefined ? 1 : c.count;
    if (c.ok) return;
    if (c.diffs && c.diffs.length > 0) c.diffs.forEach(function (d) { failures.push(d); });
    else failures.push({ text: c.detail ? c.detail : c.name });
  });
  var head = '確かめた ' + checked + ' / ' + expectedCount;
  if (checked > expectedCount) {
    return { result: '×', detail: '自己テストのコードの誤り: ' + head + (failures.length > 0 ? '。' + formatDiffs(failures, 3) : '') };
  }
  if (failures.length > 0) return { result: '×', detail: head + '。' + formatDiffs(failures, 3) };
  if (expectedCount <= 0) return { result: '未実施', detail: '実施できません: 確かめる数が 0 です' };
  if (checked < expectedCount) return { result: '未実施', detail: '実施できません: ' + head };
  return { result: '○', detail: head };
}

/**
 * 作り直しの確認（4.3）。before・after: [{ name, id, values }]（出力の名前のシート）。戻り値は itemResult に足せる checks。
 * expectStopped が偽: 実行のあとのシートのどれもが、前の ID のどれとも違う（1 シート 1 つ）。
 * expectStopped が真（C10・C18）: 前のシートの 1 つずつに「同じ名前で同じ ID」を 1 つ、そのシートの全セルの「値が同じ」を 1 セル 1 つ。
 * 前になかった名前のシートが増えていたら違いに入れる（確かめる数は増やさない）。
 */
function rebuiltCheck(before, after, expectStopped) {
  var checks = [];
  var beforeIds = before.map(function (s) { return s.id; });
  if (!expectStopped) {
    after.forEach(function (s) {
      var fresh = beforeIds.indexOf(s.id) === -1;
      checks.push({ name: '作り直し', ok: fresh, detail: '作り直されていません: ' + s.name });
    });
    return checks;
  }
  var beforeNames = before.map(function (s) { return s.name; });
  before.forEach(function (b) {
    var a = null;
    after.forEach(function (s) { if (s.name === b.name) a = s; });
    checks.push({ name: '作り直し', ok: !!a && a.id === b.id, detail: (a ? '止まるはずが作り直されました: ' : '止まるはずがシートが消えました: ') + b.name });
    var cmp = compareTables(b.values, a ? a.values : [], { name: b.name });
    checks.push({ name: b.name + ' の値', count: cmp.compared, ok: cmp.diffs.length === 0 && cmp.compared === cmp.expectedCount, diffs: cmp.diffs });
  });
  after.forEach(function (a) {
    if (beforeNames.indexOf(a.name) === -1) checks.push({ name: '作り直し', count: 0, ok: false, detail: '止まるはずがシートが増えました: ' + a.name });
  });
  return checks;
}

/** 止まる側の作り直しの確認で確かめる数（シートの数 ＋ セルの数） */
function selfTestStoppedCount_(before) {
  var n = before.length;
  before.forEach(function (s) { s.values.forEach(function (row) { n += row.length; }); });
  return n;
}

/**
 * 4.3 の期待値と守ったセルの集合。rows: ParseCsv の fields の配列（1 行目は見出し）、textCols: 文字の列（1 から）
 * 2 行目以降の文字の列に toSheetText(v, guard) を通し、変わったセルを守ったセルとする。
 */
function expectedWithGuard(rows, textCols, guard, toSheetText) {
  var guarded = {};
  var out = rows.map(function (r, i) {
    return r.map(function (v, j) {
      if (i === 0 || textCols.indexOf(j + 1) === -1) return v;
      var t = toSheetText(v, guard);
      if (t !== v) guarded[(i + 1) + ',' + (j + 1)] = true;
      return t;
    });
  });
  return { rows: out, guarded: guarded };
}

/**
 * 期待値の守ったセル（4.3）に使う、自己テスト側の決まり: guard が真で、= + - @ のどれかで始まる文字なら先頭に '。
 * 本番の toSheetText を使わない（本番の toSheetText の誤りが期待値に移ると、C01 などが偽の ○ になるため。tester 2026-10-18）。
 * 本番の決まりと同じであることは tests/selftest.test.js で確かめる。
 */
function selfTestGuardText_(value, guard) {
  if (typeof value !== 'string') return value;
  return guard && /^[=+\-@]/.test(value) ? "'" + value : value;
}

/** 未実施の理由: 'time'（時間が足りない・実行中）か 'other' */
function selfTestReason_(item) {
  if (item.result === '実行中') return 'time';
  return String(item.detail || '').indexOf('時間:') === 0 ? 'time' : 'other';
}

/**
 * 全体の判定（6.1 の 6）。plan: 判定の項目の番号の一覧、results: { 番号: { result, detail } }（判定の項目だけ）
 * 戻り値: { result: 'すべて合格' | '不合格' | '未完了', detail }
 */
function overallResult(plan, results) {
  var list = plan || [];
  var res = results || {};
  var planned = {};
  list.forEach(function (id) { planned[id] = true; });
  var errors = [];
  if (list.length === 0) errors.push('判定の項目がありません');
  Object.keys(res).forEach(function (id) { if (!selfTestHasOwn_(planned, id)) errors.push('予定にない番号の結果があります: ' + id); });
  var missing = list.filter(function (id) { return !selfTestHasOwn_(res, id) || !res[id]; });
  if (missing.length > 0) errors.push('結果のない番号があります: ' + missing.join('、'));
  if (errors.length > 0) return { result: '不合格', detail: '自己テストのコードの誤り: ' + errors.join('。') };

  var failed = list.filter(function (id) { return res[id].result === '×'; });
  var pending = list.filter(function (id) { return res[id].result === '未実施' || res[id].result === '実行中'; });
  var timePending = pending.filter(function (id) { return selfTestReason_(res[id]) === 'time'; });
  var otherPending = pending.length - timePending.length;
  var unknown = list.filter(function (id) { return ['○', '×', '未実施', '実行中'].indexOf(res[id].result) === -1; });
  if (unknown.length > 0) return { result: '不合格', detail: '自己テストのコードの誤り: 結果の値が違います: ' + unknown.join('、') };
  if (failed.length > 0) {
    var text = '× が ' + failed.length + ' 件（番号: ' + failed.join('、') + '）';
    if (timePending.length > 0) text += '。未実施 ' + timePending.length + ' 件は、もう一度押すと続きから実施します';
    return { result: '不合格', detail: text };
  }
  if (pending.length > 0) {
    if (otherPending === 0) return { result: '未完了', detail: '未実施 ' + pending.length + ' 件。もう一度「自己テスト（開発用）」を押すと続きから実施します' };
    return { result: '未完了', detail: '未実施 ' + pending.length + ' 件のうち ' + otherPending + ' 件は、押し直しても実施できません（例: ドライブの input が手元のケースと違う）。この画面を送ってください' };
  }
  return { result: 'すべて合格', detail: '判定 ' + list.length + ' 件がすべて ○（自動の項目だけ）。本番のメニューでの確認（M01）と承認画面の文（M02）は、手で書いてから送ってください' };
}

/** 個人の情報を出さない（4.2）: URL、「（ID: …）」、example.com 以外のメールアドレスを伏せる */
function selfTestSafeText_(text) {
  return String(text)
    .replace(/https?:\/\/[^\s　「」（）、。]+/g, '（URL は伏せました）')
    .replace(/（ID: [^）]*）/g, '（ID は伏せました）')
    .replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g, function (m) { return /@example\.com$/i.test(m) ? m : '（メールアドレスは伏せました）'; });
}

function selfTestSeconds_(v) {
  if (typeof v === 'number') return (Math.round(v * 10) / 10).toFixed(1);
  return v === undefined || v === null ? '' : String(v);
}

/**
 * 「自己テスト」シートの値（4.2）。すべて文字。
 * items: [{ id, kind, title, result, detail, seconds, run }]（1 つ目は全体の行）、
 * manual: [{ id, title, detail }]（M01・M02 の detail は前回から残す値。M03 は決まった文）、info: [{ id, title, detail }]
 */
function buildSelfTestValues(items, manual, info) {
  var text = function (v) { return v === undefined || v === null ? '' : selfTestSafeText_(String(v)); };
  var blank = ['', '', '', '', '', '', ''];
  var rows = [SELFTEST_HEADERS.slice()];
  items.forEach(function (it) {
    rows.push([text(it.id), text(it.kind), text(it.title), text(it.result), text(it.detail), selfTestSeconds_(it.seconds), it.run === undefined || it.run === null ? '' : String(it.run)]);
  });
  rows.push(blank.slice());
  manual.forEach(function (m) {
    var detail = m.id === 'M03' ? SELFTEST_M03_TEXT : (m.detail === undefined || m.detail === null ? '' : String(m.detail));
    rows.push([m.id, '手で確認', text(m.title), '手で', detail, '', '']);
  });
  rows.push(blank.slice());
  info.forEach(function (x) { rows.push([x.id, '情報', text(x.title), '', text(x.detail), '', '']); });
  return rows;
}

/** I01〜I04 の行（4.2）。runs: [{ run, at: 'yyyy-MM-dd HH:mm' }]、current: { version, spreadsheet, constants: [[名前, 値]] } */
function selfTestInfoRows_(runs, current, restarts) {
  return [
    { id: 'I01', title: '実行', detail: runs.map(function (r) { return r.run + '=' + r.at; }).join(' / ') },
    { id: 'I02', title: '版', detail: 'SELFTEST_VERSION=' + current.version + ' / スプレッドシート=' + current.spreadsheet },
    { id: 'I03', title: '定数', detail: current.constants.map(function (kv) { return kv[0] + '=' + kv[1]; }).join(' / ') },
    { id: 'I04', title: 'やり直し', detail: restarts },
  ];
}

/** I04 の文。counts: { G1: 数 }、groupNames: 組の名前（名前の順） */
function selfTestRestartText_(counts, groupNames, text) {
  return groupNames.map(function (g) { return g + '=' + (counts[g] || 0); }).concat([text]).join(' / ');
}

function selfTestParseRuns_(text) {
  var parts = String(text || '').split(' / ');
  var runs = [];
  for (var i = 0; i < parts.length; i++) {
    var m = /^(\d+)=(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/.exec(parts[i]);
    if (!m) return null;
    runs.push({ run: Number(m[1]), at: m[2] });
  }
  return runs.length > 0 ? runs : null;
}

/** 'yyyy-MM-dd HH:mm' を分にする（タイムゾーンは同じ前提で、差だけを使う）。読めなければ NaN */
function selfTestMinutes_(text) {
  var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 60000;
}

function selfTestParseConstants_(text) {
  var out = {};
  var parts = String(text || '').split(' / ');
  for (var i = 0; i < parts.length; i++) {
    var at = parts[i].indexOf('=');
    if (at <= 0) return null;
    out[parts[i].slice(0, at)] = parts[i].slice(at + 1);
  }
  return out;
}

function selfTestParseRestarts_(text, groupNames) {
  var counts = {};
  for (var i = 0; i < groupNames.length; i++) {
    var m = new RegExp('(?:^| )' + groupNames[i] + '=(\\d+)(?: |$)').exec(String(text || ''));
    if (!m) return null;
    counts[groupNames[i]] = Number(m[1]);
  }
  return counts;
}

function selfTestGroupNames_(groups) {
  var names = [];
  groups.forEach(function (g) { if (g.group && names.indexOf(g.group) === -1) names.push(g.group); });
  return names.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
}

/**
 * 続きの判定（6.5・6.6）。previousRows: 前回の「自己テスト」シートの値（文字）、version: SELFTEST_VERSION、
 * now: 今の 'yyyy-MM-dd HH:mm'（スクリプトのタイムゾーン）、current: { version, spreadsheet, constants: [[名前, 値]] }、
 * groups: SELFTEST_PLAN の順の [{ id, group }]
 * 戻り値: { fresh: true, reason } か { fresh: false, run, runs, carry（残す結果）, todo（流す番号）, restartCounts, restarts（I04 の文） }
 */
function resumePoint(previousRows, version, now, current, groups) {
  var byId = {};
  (previousRows || []).forEach(function (r) {
    if (r && r.length > 0 && String(r[0]) !== '' && !selfTestHasOwn_(byId, String(r[0]))) byId[String(r[0])] = r.map(String);
  });
  var fresh = function (reason) { return { fresh: true, reason: reason }; };
  if (!byId.I01 && !byId.I02 && !byId.I03) return fresh('');
  var detailOf = function (id) { return byId[id] && byId[id][4] !== undefined ? byId[id][4] : ''; };

  var i02 = /^SELFTEST_VERSION=(.*?) \/ スプレッドシート=(.*)$/.exec(detailOf('I02'));
  if (!i02) return fresh('前回の版を読めないので最初から実施');
  if (i02[1] !== version) return fresh('自己テストの版が変わったので最初から実施（' + i02[1] + ' → ' + version + '）');
  if (i02[2] !== current.spreadsheet) return fresh('スプレッドシートの名前が変わったので最初から実施');
  var runs = selfTestParseRuns_(detailOf('I01'));
  if (!runs) return fresh('前回の実行の時刻を読めないので最初から実施');
  var last = runs[runs.length - 1];
  var minutes = selfTestMinutes_(now) - selfTestMinutes_(last.at);
  if (isNaN(minutes) || minutes < 0 || minutes * 60000 > SELFTEST_RESUME_MS) return fresh('前回から 60 分を過ぎたので最初から実施');

  var prevConstants = selfTestParseConstants_(detailOf('I03'));
  if (!prevConstants) return fresh('前回の定数を読めないので最初から実施');
  var changed = [];
  var notes = [];
  current.constants.forEach(function (kv) {
    var before = prevConstants[kv[0]];
    if (kv[0] === 'コード' && before === '取れません' && kv[1] === '取れません') {
      notes.push('コードの指紋は取れないので比べていません');
      return;
    }
    if (before !== kv[1]) changed.push(kv[0] + ': ' + (before === undefined ? '（なし）' : before) + ' → ' + kv[1]);
  });
  if (changed.length > 0) return fresh('定数が変わったので最初から実施（' + changed.join('、') + '）');

  var groupNames = selfTestGroupNames_(groups);
  var counts = selfTestParseRestarts_(detailOf('I04'), groupNames);
  if (!counts) return fresh('前回のやり直しの回数を読めないので最初から実施');
  var prev = {};
  for (var i = 0; i < groups.length; i++) {
    var row = byId[groups[i].id];
    if (!row || row.length < 7) return fresh('前回の結果の形が違うので最初から実施');
    prev[groups[i].id] = { result: row[3], detail: row[4], seconds: row[5], run: row[6] };
  }
  var pending = function (id) { return prev[id].result === '実行中' || (prev[id].result === '未実施' && prev[id].detail.indexOf('時間:') === 0); };
  if (!groups.some(function (g) { return pending(g.id); })) return fresh('前回は最後まで実施したので最初から実施');

  var run = last.run + 1;
  var carry = {};
  var todo = {};
  groups.forEach(function (g) {
    var p = prev[g.id];
    carry[g.id] = { result: p.result, detail: p.detail, seconds: p.seconds, run: p.run };
  });
  // 実行中のまま残った項目（強制的に止められた）は ×、同じ組のまだの項目は実施できない
  groups.forEach(function (g) {
    if (prev[g.id].result !== '実行中') return;
    carry[g.id] = { result: '×', detail: '6 分の上限で止まった可能性があります', seconds: prev[g.id].seconds, run: prev[g.id].run };
    if (!g.group) return;
    groups.forEach(function (h) {
      if (h.group === g.group && h.id !== g.id && pending(h.id) && prev[h.id].result !== '実行中') {
        carry[h.id] = { result: '未実施', detail: '実施できません: 同じ組の ' + g.id + ' が途中で止まったため', seconds: '', run: String(run) };
      }
    });
  });
  var restartNotes = [];
  groupNames.forEach(function (name) {
    var members = groups.filter(function (g) { return g.group === name; });
    if (members.some(function (m) { return prev[m.id].result === '実行中'; })) return;
    var waiting = members.filter(function (m) { return pending(m.id); });
    if (waiting.length === 0) return;
    if (waiting.length === members.length) {
      members.forEach(function (m) { todo[m.id] = true; });
      return;
    }
    if (counts[name] >= 1) {
      waiting.forEach(function (m) {
        carry[m.id] = { result: '未実施', detail: '実施できません: ' + name + ' が 1 回の実行の時間に収まりません。この画面を送ってください', seconds: '', run: String(run) };
      });
      return;
    }
    counts[name] += 1;
    members.forEach(function (m) { todo[m.id] = true; });
    restartNotes.push(run + ' 回目: ' + members[0].id + ' から（' + members[0].id + ' と同じ回に ' + waiting[0].id + ' を実施できなかったため）');
  });
  groups.forEach(function (g) {
    if (!g.group && pending(g.id) && prev[g.id].result !== '実行中') todo[g.id] = true;
  });
  var todoList = groups.filter(function (g) { return todo[g.id]; }).map(function (g) { return g.id; });
  todoList.forEach(function (id) { delete carry[id]; });
  var allNotes = restartNotes.concat(notes);
  return {
    fresh: false,
    run: run,
    runs: runs,
    carry: carry,
    todo: todoList,
    restartCounts: counts,
    restarts: selfTestRestartText_(counts, groupNames, allNotes.length > 0 ? allNotes.join('。') : run + ' 回目: 続きから'),
  };
}

/** 文字の配列から 8 桁の 16 進の値（FNV-1a の 32 ビット、小文字）。各文字の UTF-16 のコード単位を下位・上位の 2 バイトとして足す */
function codeFingerprint(sources) {
  var h = 0x811c9dc5;
  for (var i = 0; i < sources.length; i++) {
    var s = String(sources[i]) + '\u0000';
    for (var j = 0; j < s.length; j++) {
      var c = s.charCodeAt(j);
      h ^= c & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= c >>> 8;
      h = Math.imul(h, 0x01000193);
    }
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

/**
 * コードの指紋に渡す文字の配列（8.3）。lookup(name) は値を返す関数（GAS ではグローバルから引く）。
 * 戻り値: { sources, ok }。ok が偽（引けない関数・ソースを返さない toString・undefined の var）なら I03 は「コード=取れません」
 */
function fingerprintSources(names, varNames, lookup) {
  var sources = [];
  var ok = true;
  var get = function (name) {
    try { return lookup(name); } catch (e) { return undefined; }
  };
  names.forEach(function (name) {
    var fn = get(name);
    if (typeof fn !== 'function') { ok = false; sources.push('f:' + name + ':?'); return; }
    var text = String(fn.toString());
    if (text.indexOf('function ' + name + '(') === -1) ok = false;
    sources.push('f:' + name + ':' + text);
  });
  varNames.forEach(function (name) {
    var v = get(name);
    if (v === undefined) { ok = false; sources.push('v:' + name + ':?'); return; }
    // SELFTEST_PLAN の run のように値に関数があれば、名前を残す（どの関数を呼ぶかを変えても指紋が変わるように。tester 2026-10-18）
    sources.push('v:' + name + ':' + JSON.stringify(v, function (k, x) { return typeof x === 'function' ? 'function ' + x.name : x; }));
  });
  return { sources: sources, ok: ok };
}

/**
 * 最後の画面の文。M01・M02 を書いて送るのは「すべて合格」か「不合格」のときだけ（監査 推奨 1）。
 * 「未完了」のときは、押し直すか（続きから）、画面を送るか（押し直しても実施できない）を overall.detail が伝える
 */
function selfTestFinalMessage_(overall) {
  var head = '自己テストの結果: ' + overall.result + '。' + selfTestSafeText_(overall.detail);
  if (overall.result === '未完了') return head + '\nM01・M02 はまだ書かないでください。';
  return head + '\nM01・M02 を書いてから「自己テスト」シートを送ってください。';
}

/**
 * アップロードされたファイルの確認（4.4）。expectedList: { 'ケース/パス': バイト数 }、driveList: [{ path, size, mimeType }]
 * 戻り値: 違いの文の配列（足りない・多い・大きさが違う・Google 形式・同じ名前が 2 つ）
 */
function checkUploadedFiles(expectedList, driveList) {
  var diffs = [];
  var seen = {};
  driveList.forEach(function (f) {
    if (selfTestHasOwn_(seen, f.path)) { diffs.push(f.path + ' が 2 つあります'); return; }
    seen[f.path] = f;
  });
  Object.keys(expectedList).forEach(function (p) {
    if (!selfTestHasOwn_(seen, p)) { diffs.push(p + ' がありません'); return; }
    var f = seen[p];
    if (String(f.mimeType || '').indexOf(SELFTEST_GOOGLE_MIME_PREFIX) === 0) diffs.push(p + ' が Google 形式に変わっています');
    else if (f.size !== expectedList[p]) diffs.push(p + ' の大きさ（期待 ' + expectedList[p] + '、実際 ' + f.size + '）');
  });
  Object.keys(seen).forEach(function (p) {
    if (!selfTestHasOwn_(expectedList, p)) diffs.push(p + ' は手元のケースにありません');
  });
  return diffs;
}

// ==================== GAS の処理 ====================

/** メニューから実行 */
function runSelfTest() {
  selfTest_();
}

/**
 * 本体。clock: 経過時間を測る関数（ミリ秒。今の時刻にも使う）。省略時は Date.now。テストから時間を進めるために渡す。
 * 戻り値（テスト用）: { status, overall? }
 */
function selfTest_(clock) {
  var tick = clock || function () { return Date.now(); };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  if (String(ss.getName()).indexOf(SELFTEST_NAME_PREFIX) !== 0) {
    ui.alert(SELFTEST_NAME_MESSAGE);
    return { status: 'notTestSpreadsheet' };
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) {
    ui.alert('自己テストが実行中です。終わってからもう一度押してください。');
    return { status: 'locked' };
  }
  try {
    return selfTestLocked_(ss, ui, tick);
  } catch (err) {
    console.error(err && err.stack || err);
    ui.alert('自己テストが止まりました（「自己テスト」シートが書けていない可能性があります）: ' + selfTestMessage_(err));
    return { status: 'error', message: selfTestMessage_(err) };
  } finally {
    lock.releaseLock();
  }
}

function selfTestMessage_(err) {
  return String(err && err.message || err);
}

function selfTestLocked_(ss, ui, tick) {
  // 1. 前回の「自己テスト」シート（自己テストのものでなければ何も書かずに止める）
  var existing = ss.getSheetByName(SELFTEST_SHEET);
  var previousRows = null;
  if (existing) {
    var lastColumn = existing.getLastColumn();
    var header = lastColumn > 0 ? existing.getRange(1, 1, 1, lastColumn).getValues()[0].map(String) : [];
    if (header.join('\t') !== SELFTEST_HEADERS.join('\t')) {
      ui.alert('「自己テスト」シートが自己テストのものではありません（1 行目の見出しが違います）。「自己テスト」シートの名前を変えてから実行してください。');
      return { status: 'foreignSheet' };
    }
    previousRows = selfTestSheetText_(existing);
  }

  // 2. ケースのフォルダ
  var found = selfTestFindCases_(ss);
  if (found.stop) {
    ui.alert(found.stop);
    return { status: 'noCases' };
  }

  // 3. 回の始めに 1 回だけ読む値（I02・I03。任意 4）
  var start = tick();
  var nowText = Utilities.formatDate(new Date(start), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var print = fingerprintSources(SELFTEST_FINGERPRINT_FUNCS, SELFTEST_FINGERPRINT_VARS, function (name) { return globalThis[name]; });
  var current = {
    version: SELFTEST_VERSION,
    spreadsheet: String(ss.getName()),
    constants: [
      ['SJIS_CHARSET', String(SJIS_CHARSET)],
      ['FORMULA_GUARD', String(FORMULA_GUARD)],
      ['ケースのフォルダ', codeFingerprint([found.folder.getId()])],
      ['コード', print.ok ? codeFingerprint(print.sources) : '取れません'],
    ],
  };
  var groups = SELFTEST_PLAN.map(function (p) { return { id: p.id, group: p.group || '' }; });
  var groupNames = selfTestGroupNames_(groups);
  var decision = previousRows ? resumePoint(previousRows, SELFTEST_VERSION, nowText, current, groups) : { fresh: true, reason: '' };

  // 4. M01・M02 の書き込み（推奨 6）。続きなら残す、作り直しで書き込みがあれば何も書かずに止める
  var manualPrev = {};
  (previousRows || []).forEach(function (r) { if (r[0] === 'M01' || r[0] === 'M02') manualPrev[r[0]] = r[4] === undefined ? '' : String(r[4]); });
  var written = ['M01', 'M02'].filter(function (id) { return selfTestHasOwn_(manualPrev, id) && String(manualPrev[id]).replace(/[\s　]/g, '') !== ''; });
  if (decision.fresh && previousRows && written.length > 0) {
    ui.alert(SELFTEST_MANUAL_STOP_MESSAGE);
    return { status: 'manualWritten' };
  }

  // 5. 前回の残りを片付ける（作業用のシート、C10 の空の「明細」。推奨 5）
  var leftWork = ss.getSheetByName(SELFTEST_WORK_SHEET);
  if (leftWork) ss.deleteSheet(leftWork);
  var leftDetails = ss.getSheetByName('明細');
  if (leftDetails && leftDetails.getLastRow() === 0) ss.deleteSheet(leftDetails);

  // 6. この回の状態
  var run = decision.fresh ? 1 : decision.run;
  var runs = (decision.fresh ? [] : decision.runs).concat([{ run: run, at: nowText }]);
  var restarts = decision.fresh
    ? selfTestRestartText_({}, groupNames, decision.reason ? decision.reason : 'なし')
    : decision.restarts;
  var ctx = {
    ss: ss,
    clock: tick,
    start: start,
    run: run,
    casesFolder: found.folder,
    secrets: [found.folder.getId()],
    info: selfTestInfoRows_(runs, current, restarts),
    results: {},
    manual: SELFTEST_MANUAL.map(function (m) { return { id: m.id, title: m.title, detail: decision.fresh ? '' : manualPrev[m.id] }; }),
    caseChecks: {},
    caseData: {},
    expected: {},
    state: {},
    overall: { result: '未完了', detail: '途中で止まりました。もう一度「自己テスト（開発用）」を押すと続きから実施します' },
    cleanupError: '',
    sheet: null,
  };
  var todo = {};
  (decision.fresh ? SELFTEST_PLAN.map(function (p) { return p.id; }) : decision.todo).forEach(function (id) { todo[id] = true; });
  SELFTEST_PLAN.forEach(function (p) {
    ctx.results[p.id] = todo[p.id] ? { result: '未実施', detail: SELFTEST_NOT_YET, seconds: '', run: run } : decision.carry[p.id];
  });

  // 7. ケースのファイルの確認（回ごとに毎回。推奨 3）と、M01 の行の番号
  var usedCases = ['01-basic'];
  SELFTEST_PLAN.forEach(function (p) {
    if (todo[p.id]) p.cases.forEach(function (c) { if (usedCases.indexOf(c) === -1) usedCases.push(c); });
  });
  usedCases.forEach(function (c) { selfTestCheckCase_(ctx, c); });
  ctx.manual[0].title = ctx.manual[0].title.replace('{N}', selfTestDetailLastRow_(ctx));

  ctx.sheet = selfTestPrepareSheet_(ctx, decision.fresh);
  selfTestWrite_(ctx);

  // 8. 項目を順に流す
  for (var i = 0; i < SELFTEST_PLAN.length; i++) {
    var p = SELFTEST_PLAN[i];
    if (!todo[p.id] || p.by) continue;
    if (ctx.cleanupError) {
      selfTestSetWithRecords_(ctx, p, { result: '未実施', detail: '実施できません: 自己テストの片付けに失敗したため', seconds: '' });
      continue;
    }
    if (tick() - start > SELFTEST_LIMIT_MS) {
      for (var k = i; k < SELFTEST_PLAN.length; k++) {
        if (todo[SELFTEST_PLAN[k].id]) ctx.results[SELFTEST_PLAN[k].id] = { result: '未実施', detail: SELFTEST_TIME_UP, seconds: '', run: run };
      }
      break;
    }
    var problems = [];
    p.cases.forEach(function (c) { problems = problems.concat(selfTestCheckCase_(ctx, c)); });
    if (problems.length > 0) {
      selfTestSetWithRecords_(ctx, p, {
        result: '未実施',
        detail: '実施できません: ドライブのファイルが手元のケースと違います: ' + problems[0] + (problems.length > 1 ? '（ほか ' + (problems.length - 1) + ' 件）' : ''),
        seconds: '',
      });
      selfTestWrite_(ctx);
      continue;
    }
    ctx.results[p.id] = { result: '実行中', detail: '', seconds: '', run: run };
    selfTestWrite_(ctx);
    selfTestRunItem_(ctx, p);
    selfTestWrite_(ctx);
  }

  // 9. 全体の判定
  var finalWork = ss.getSheetByName(SELFTEST_WORK_SHEET);
  if (finalWork) {
    try { ss.deleteSheet(finalWork); } catch (e) { ctx.cleanupError = ctx.cleanupError || selfTestMessage_(e); }
  }
  ctx.overall = selfTestOverall_(ctx);
  ctx.overallSeconds = (tick() - start) / 1000;
  selfTestWrite_(ctx);
  ctx.sheet.activate();
  ui.alert(selfTestFinalMessage_(ctx.overall));
  return { status: 'done', overall: ctx.overall };
}

/** 全体の判定。片付けに失敗したら不合格（7 章） */
function selfTestOverall_(ctx) {
  var plan = SELFTEST_PLAN.filter(function (p) { return p.kind === '判定'; }).map(function (p) { return p.id; });
  var results = {};
  plan.forEach(function (id) { results[id] = ctx.results[id]; });
  var overall = overallResult(plan, results);
  if (ctx.cleanupError) return { result: '不合格', detail: '自己テストの片付けに失敗しました: ' + ctx.cleanupError + '。' + overall.detail };
  return overall;
}

/** p の結果と、p の関数の中で記録する項目（C06）の結果を同じにする（流せなかったとき） */
function selfTestSetWithRecords_(ctx, p, value) {
  [p].concat(SELFTEST_PLAN.filter(function (q) { return q.by === p.id; })).forEach(function (q) {
    ctx.results[q.id] = { result: value.result, detail: value.detail, seconds: value.seconds, run: ctx.run };
  });
}

/** 1 つの項目を流して結果を入れる。例外は ×（記録の項目は「記録できず」） */
function selfTestRunItem_(ctx, p) {
  var c = selfTestItemContext_(ctx);
  var t0 = ctx.clock();
  var value;
  var error = null;
  try {
    p.run(c);
  } catch (e) {
    error = e;
    console.error(e && e.stack || e);
  }
  var seconds = (ctx.clock() - t0) / 1000;
  if (error) {
    value = p.kind === '記録'
      ? { result: '記録', detail: '記録できず（例外: ' + selfTestMessage_(error) + '）' }
      : { result: '×', detail: '例外: ' + selfTestMessage_(error) };
  } else {
    value = selfTestFinish_(c, p);
  }
  if (ctx.cleanupError && value.result !== '×' && p.kind === '判定') {
    value = { result: '×', detail: '自己テストの片付けに失敗しました: ' + ctx.cleanupError };
  }
  ctx.results[p.id] = { result: value.result, detail: value.detail, seconds: seconds, run: ctx.run };
  // この項目の関数の中で記録する項目（C06）
  SELFTEST_PLAN.forEach(function (q) {
    if (q.by !== p.id) return;
    var rec;
    if (selfTestHasOwn_(c.records, q.id)) rec = { result: '記録', detail: c.records[q.id] };
    else if (value.result === '未実施') rec = { result: '未実施', detail: value.detail };
    else rec = { result: '記録', detail: '記録できず（' + (error ? '例外: ' + selfTestMessage_(error) : p.id + ' の途中で止まりました') + '）' };
    ctx.results[q.id] = { result: rec.result, detail: rec.detail, seconds: '', run: ctx.run };
  });
}

/** 項目の関数に渡すもの。expect で確かめるはずの数を決め、check で 1 つずつ確かめる（必須 1） */
function selfTestItemContext_(ctx) {
  var c = {
    ss: ctx.ss,
    clock: ctx.clock,
    run: ctx,
    state: ctx.state,
    expected: 0,
    checks: [],
    notes: [],
    notRunText: null,
    recordText: null,
    records: {},
  };
  c.expect = function (n) { c.expected += n; };
  c.check = function (name, ok, detail) { c.checks.push({ name: name, ok: !!ok, detail: detail }); };
  c.checkTable = function (name, cmp) {
    c.checks.push({ name: name, count: cmp.compared, ok: cmp.diffs.length === 0 && cmp.compared === cmp.expectedCount, diffs: cmp.diffs });
  };
  c.addChecks = function (list) { list.forEach(function (x) { c.checks.push(x); }); };
  c.note = function (text) { c.notes.push(text); };
  c.notRun = function (text) { c.notRunText = text; };
  c.record = function (text) { c.recordText = text; };
  c.recordFor = function (id, text) { c.records[id] = text; };
  c.cleanup = function (fn) {
    try { fn(); } catch (e) { ctx.cleanupError = ctx.cleanupError || selfTestMessage_(e); }
  };
  return c;
}

function selfTestFinish_(c, p) {
  // 違いが 1 つでもあれば、途中で実施できなくなっても ×（5 章の冒頭。未実施で × を隠さない。tester 2026-10-18）
  if (c.notRunText && p.kind === '判定' && c.checks.some(function (x) { return !x.ok; })) {
    var failed = itemResult(c.expected, c.checks);
    return { result: '×', detail: failed.detail + '。' + c.notRunText };
  }
  if (c.notRunText) return { result: '未実施', detail: c.notRunText };
  if (p.kind === '記録') return { result: '記録', detail: c.recordText === null ? '記録できず（記録がありません）' : c.recordText };
  var r = itemResult(c.expected, c.checks);
  return { result: r.result, detail: c.notes.length > 0 ? r.detail + '。' + c.notes.join('。') : r.detail };
}

// ---- 「自己テスト」シート ----

function selfTestValues_(ctx) {
  var redact = function (text) {
    var s = text === undefined || text === null ? '' : String(text);
    ctx.secrets.forEach(function (id) { if (id) s = s.split(id).join('（ID）'); });
    return s;
  };
  var items = [{ id: '0', kind: '全体', title: '全体の判定', result: ctx.overall.result, detail: redact(ctx.overall.detail), seconds: ctx.overallSeconds === undefined ? '' : ctx.overallSeconds, run: ctx.run }];
  SELFTEST_PLAN.forEach(function (p) {
    var r = ctx.results[p.id];
    items.push({ id: p.id, kind: p.kind, title: p.title, result: r.result, detail: redact(r.detail), seconds: r.seconds, run: r.run });
  });
  return buildSelfTestValues(items, ctx.manual, ctx.info);
}

/** シートを用意する。作り直しなら消して作る。書く範囲を全部 @ にしてから色と幅を付ける（推奨 6） */
function selfTestPrepareSheet_(ctx, fresh) {
  var ss = ctx.ss;
  var sheet = ss.getSheetByName(SELFTEST_SHEET);
  if (fresh && sheet) {
    ss.deleteSheet(sheet);
    sheet = null;
  }
  if (!sheet) sheet = ss.insertSheet(SELFTEST_SHEET, 0);
  var values = selfTestValues_(ctx);
  var rows = values.length;
  var cols = SELFTEST_HEADERS.length;
  sheet.getRange(1, 1, rows, cols).setNumberFormat('@');
  sheet.getRange(1, 1, rows, cols).setBackgrounds(values.map(function (row, i) {
    return row.map(function (v, j) {
      if (i === 0) return SELFTEST_COLOR_HEADER;
      return j === 4 && (row[0] === 'M01' || row[0] === 'M02') ? SELFTEST_COLOR_INPUT : '#ffffff';
    });
  }));
  sheet.getRange(1, 1, 1, cols).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(3, 320);
  sheet.setColumnWidth(5, 480);
  sheet.getRange(1, 5, rows, 1).setWrap(true);
  return sheet;
}

/** 値だけを書く（数式は使わない）。× の D 列だけ赤。毎回 flush する（6.1 の 1） */
function selfTestWrite_(ctx) {
  var values = selfTestValues_(ctx);
  var range = ctx.sheet.getRange(1, 1, values.length, SELFTEST_HEADERS.length);
  range.setValues(values);
  range.setFontColors(values.map(function (row, i) {
    return row.map(function (v, j) { return i > 0 && j === 3 && v === '×' ? SELFTEST_COLOR_RED : '#000000'; });
  }));
  SpreadsheetApp.flush();
}

// ---- ケースのフォルダ ----

/** cases フォルダを探す（4.1）。戻り値: { folder } か { stop: 文 } */
function selfTestFindCases_(ss) {
  var settings = ss.getSheetByName(SELFTEST_SETTINGS_SHEET);
  var value = settings ? selfTestSettingValue_(settings, 'CASES_FOLDER') : '';
  if (value !== '') {
    var id = extractFolderId(value);
    if (id === '') return { stop: '「' + SELFTEST_SETTINGS_SHEET + '」の CASES_FOLDER からフォルダの ID を読み取れません。cases フォルダを開いたときのアドレス欄の URL を貼ってください。' };
    var folder;
    try {
      folder = DriveApp.getFolderById(id);
      folder.getName();
    } catch (e) {
      return { stop: '「' + SELFTEST_SETTINGS_SHEET + '」の CASES_FOLDER のフォルダを開けません。URL と、自分がそのフォルダを見られるかを確かめてください。' };
    }
    if (!selfTestChildFolder_(folder, '01-basic')) return { stop: '「' + SELFTEST_SETTINGS_SHEET + '」の CASES_FOLDER のフォルダに 01-basic がありません。excel-csv-aggregator/tests/cases フォルダの URL を貼ってください。' };
    return { folder: folder };
  }
  var found = null;
  try {
    found = [];
    var it = DriveApp.getFoldersByName('cases');
    while (it.hasNext()) {
      var f = it.next();
      if (!f.isTrashed() && selfTestChildFolder_(f, '01-basic')) found.push(f);
    }
  } catch (e) {
    found = null;
  }
  if (found && found.length === 1) return { folder: found[0] };
  selfTestCreateSettingsSheet_(ss);
  var head = !found ? 'ドライブで cases フォルダを探せませんでした。'
    : found.length === 0 ? 'ドライブで cases フォルダ（中に 01-basic があるもの）が見つかりませんでした。'
    : 'ドライブに cases フォルダ（中に 01-basic があるもの）が ' + found.length + ' つあります。';
  return { stop: head + '「' + SELFTEST_SETTINGS_SHEET + '」シートの黄色のセルに、使う cases フォルダの URL を貼ってから、もう一度押してください。' };
}

function selfTestSettingValue_(sheet, key) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  var rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).replace(/^[\s　]+|[\s　]+$/g, '') === key) return String(rows[i][1]).replace(/^[\s　]+|[\s　]+$/g, '');
  }
  return '';
}

/** 「自己テスト設定」シート（キー / 値 / 説明。DESIGN.md の形）。あれば作り直さない */
function selfTestCreateSettingsSheet_(ss) {
  if (ss.getSheetByName(SELFTEST_SETTINGS_SHEET)) return;
  var sheet = ss.insertSheet(SELFTEST_SETTINGS_SHEET);
  sheet.getRange(1, 1, 2, 3).setNumberFormat('@');
  sheet.getRange(1, 1, 2, 3).setValues([
    ['キー', '値', '説明'],
    ['CASES_FOLDER', '', 'ドライブにアップロードした excel-csv-aggregator/tests/cases フォルダの URL（フォルダを開いたときのアドレス欄をそのまま貼る）'],
  ]);
  sheet.getRange(1, 1, 1, 3).setBackground(SELFTEST_COLOR_HEADER).setFontWeight('bold');
  sheet.getRange(2, 2).setBackground(SELFTEST_COLOR_INPUT);
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 360);
  sheet.setColumnWidth(3, 560);
}

/** 名前が name の、ゴミ箱に入っていない子のフォルダ。なければ null */
function selfTestChildFolder_(folder, name) {
  var it = folder.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed() && f.getName() === name) return f;
  }
  return null;
}

/** ゴミ箱に入っていない、名前が name のファイル。なければ null */
function selfTestFile_(folder, name) {
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed() && f.getName() === name) return f;
  }
  return null;
}

/** ケースのフォルダのファイルを手元の一覧（CASE_FILES）と比べる（4.4）。回ごとに 1 回だけ。戻り値: 違いの文の配列 */
function selfTestCheckCase_(ctx, caseName) {
  if (selfTestHasOwn_(ctx.caseChecks, caseName)) return ctx.caseChecks[caseName];
  var files = selfTestHasOwn_(CASE_FILES, caseName) ? CASE_FILES[caseName] : {};
  var expected = {};
  Object.keys(files).forEach(function (p) { expected[caseName + '/' + p] = files[p]; });
  var problems;
  try {
    var folder = selfTestChildFolder_(ctx.casesFolder, caseName);
    if (!folder) {
      problems = [caseName + ' のフォルダがありません'];
    } else {
      var list = [];
      var add = function (f, prefix) {
        var it = f.getFiles();
        while (it.hasNext()) {
          var file = it.next();
          if (!file.isTrashed()) list.push({ path: prefix + file.getName(), size: file.getSize(), mimeType: file.getMimeType() });
        }
      };
      add(folder, caseName + '/');
      ['input', 'expected'].forEach(function (sub) {
        var f = selfTestChildFolder_(folder, sub);
        if (f) add(f, caseName + '/' + sub + '/');
      });
      problems = checkUploadedFiles(expected, list);
    }
  } catch (e) {
    problems = [caseName + ' のファイルを読めません: ' + selfTestMessage_(e)];
  }
  if (Object.keys(files).length === 0) problems.push(caseName + ' は手元の一覧（CASE_FILES）にありません');
  ctx.caseChecks[caseName] = problems;
  return problems;
}

/** ケースのフォルダ・input の ID・settings.json（1 回の実行の中で 1 回だけ読む） */
function selfTestCase_(c, caseName) {
  var ctx = c.run;
  if (selfTestHasOwn_(ctx.caseData, caseName)) return ctx.caseData[caseName];
  var data;
  try {
    var folder = selfTestChildFolder_(ctx.casesFolder, caseName);
    var input = folder ? selfTestChildFolder_(folder, 'input') : null;
    var expected = folder ? selfTestChildFolder_(folder, 'expected') : null;
    var file = folder ? selfTestFile_(folder, 'settings.json') : null;
    if (!input || !expected || !file) {
      data = { error: caseName + ' の input・expected・settings.json のどれかがありません' };
    } else {
      ctx.secrets.push(folder.getId(), input.getId(), expected.getId());
      var settings = null;
      try {
        settings = JSON.parse(StripBom(file.getBlob().getDataAsString('UTF-8')));
      } catch (e) {
        settings = null;
      }
      if (!settings || typeof settings !== 'object' || !settings.colNames || typeof settings.colNames !== 'object') {
        data = { error: caseName + '/settings.json を JSON として読めません' };
      } else {
        data = { inputId: input.getId(), input: input, expected: expected, settings: settings };
      }
    }
  } catch (e) {
    data = { error: caseName + ' を読めません: ' + selfTestMessage_(e) };
  }
  ctx.caseData[caseName] = data;
  return data;
}

/** 期待値の CSV（4.3）。戻り値: { raw（ParseCsv の fields）} か { error } */
function selfTestExpectedRaw_(c, caseName, fileName) {
  var ctx = c.run;
  var key = caseName + '/' + fileName;
  if (selfTestHasOwn_(ctx.expected, key)) return ctx.expected[key];
  var kase = selfTestCase_(c, caseName);
  var out;
  if (kase.error) {
    out = { error: kase.error };
  } else {
    var file = selfTestFile_(kase.expected, fileName);
    if (!file) out = { error: '期待値のファイルがありません: ' + caseName + '/expected/' + fileName };
    else if (String(file.getMimeType()).indexOf(SELFTEST_GOOGLE_MIME_PREFIX) === 0) out = { error: '期待値のファイルが Google 形式に変わっています: ' + caseName + '/expected/' + fileName };
    else {
      try {
        var raw = ParseCsv(StripBom(file.getBlob().getDataAsString('UTF-8'))).map(function (r) { return r.fields; });
        out = raw.length < 2 ? { error: '期待値が見出しだけです: ' + caseName + '/expected/' + fileName } : { raw: raw };
      } catch (e) {
        out = { error: '期待値のファイルを読めません: ' + caseName + '/expected/' + fileName + ': ' + selfTestMessage_(e) };
      }
    }
  }
  ctx.expected[key] = out;
  return out;
}

/** 期待値に selfTestGuardText_ を通したもの（FORMULA_GUARD は実行時の値）。読めなければ c.notRun して null */
function selfTestExpected_(c, caseName, fileName, sheetName, pickRows) {
  var e = selfTestExpectedRaw_(c, caseName, fileName);
  if (e.error) {
    c.notRun('実施できません: ' + e.error);
    return null;
  }
  var raw = pickRows ? pickRows.map(function (i) { return e.raw[i]; }).filter(function (r) { return r !== undefined; }) : e.raw;
  var out = expectedWithGuard(raw, SELFTEST_TEXT_COLS[sheetName], FORMULA_GUARD, selfTestGuardText_);
  out.raw = raw;
  out.cells = 0;
  raw.forEach(function (r) { out.cells += r.length; });
  out.guardedCount = Object.keys(out.guarded).length;
  return out;
}

/** 4 つの表の期待値。読めなければ null */
function selfTestFour_(c, caseName) {
  var data = { tables: {}, cells: 0, guardedCount: 0 };
  for (var i = 0; i < SELFTEST_FOUR.length; i++) {
    var name = SELFTEST_FOUR[i];
    var e = selfTestExpected_(c, caseName, SELFTEST_EXPECTED_FILES[name], name);
    if (!e) return null;
    data.tables[name] = e;
    data.cells += e.cells;
    data.guardedCount += e.guardedCount;
  }
  return data;
}

/** M01 に書く「明細」の最後の行の番号（期待値の明細の行の数。見出しを含む） */
function selfTestDetailLastRow_(ctx) {
  if (ctx.caseChecks['01-basic'] && ctx.caseChecks['01-basic'].length > 0) return 'ドライブのケースが手元と違うので書けません';
  var c = selfTestItemContext_(ctx);
  var e = selfTestExpectedRaw_(c, '01-basic', 'details.csv');
  return e.error ? '期待値を読めないので書けません' : e.raw.length + ' 行目なら一致';
}

// ---- 集計を流す ----

/** ケースの設定（cases.test.js の caseSettings と同じ作り方）。値が undefined のキーは行を作らない */
function selfTestSettingsRows_(s, inputId, overrides) {
  var values = {
    CSV_FOLDER: inputId,
    ENCODING: s.encoding,
    COL_DATE: s.colNames.date,
    COL_PRODUCT: s.colNames.product,
    COL_QUANTITY: s.colNames.quantity,
    COL_AMOUNT: s.colNames.amount,
    COL_ORDER_ID: s.colNames.orderId,
    DEDUPE: s.dedupe,
    QUOTE_CHECK: s.quoteCheck === undefined ? true : s.quoteCheck,
  };
  Object.keys(overrides || {}).forEach(function (k) { values[k] = overrides[k]; });
  return Object.keys(values).filter(function (k) { return values[k] !== undefined; }).map(function (k) { return [k, values[k]]; });
}

/** 出力の名前のシート: [{ name, id, values（文字） }] */
function selfTestOutputs_(ss) {
  var out = [];
  SELFTEST_OUTPUT_SHEETS.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (sheet) out.push({ name: name, id: sheet.getSheetId(), values: selfTestSheetText_(sheet) });
  });
  return out;
}

function selfTestSheetText_(sheet) {
  return sheet.getDataRange().getValues().map(function (r) { return r.map(function (v) { return v === null || v === undefined ? '' : String(v); }); });
}

/** 最初の全部空の行より前（「取り込み結果」「エラー」の表の部分） */
function selfTestTablePart_(rows) {
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].every(function (v) { return v === ''; })) return rows.slice(0, i);
  }
  return rows;
}

function selfTestSheetById_(ss, id) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === id) return sheets[i];
  return null;
}

/** ケースを集計する。設定を作れなければ c.notRun して null。戻り値: { result, before, after } */
function selfTestRunCase_(c, caseName, overrides) {
  var kase = selfTestCase_(c, caseName);
  if (kase.error) {
    c.notRun('実施できません: ' + kase.error);
    return null;
  }
  var settings = readSettings(selfTestSettingsRows_(kase.settings, kase.inputId, overrides));
  var before = selfTestOutputs_(c.ss);
  var result = aggregateWith_(c.clock, settings);
  return { result: result, before: before, after: selfTestOutputs_(c.ss) };
}

function selfTestCheckStatus_(c, result, expected) {
  var ok = result.status === expected;
  c.check('status', ok, 'status が「' + result.status + '」（期待「' + expected + '」）: ' + String(result.message || '').slice(0, 120));
}

/** シートの組（4.3）。four: 4 つちょうど、error: 「エラー」だけ。「（作成中）」が残っていない */
function selfTestCheckSet_(c, kind) {
  var want = kind === 'four' ? SELFTEST_FOUR : ['エラー'];
  var names = SELFTEST_OUTPUT_SHEETS.filter(function (n) { return !!c.ss.getSheetByName(n); });
  var working = c.ss.getSheets().map(function (s) { return s.getName(); }).filter(function (n) { return /（作成中）$/.test(n); });
  var ok = names.join('・') === want.join('・') && working.length === 0;
  c.check('シートの組', ok, 'シートの組が違います: ' + (names.join('・') || 'なし') + (working.length > 0 ? '（残っている: ' + working.join('・') + '）' : ''));
}

/** 4 つの表を expected と比べる。withFormulas なら守ったセルの getFormulas も見る。戻り値: ' あり・なしの数 */
function selfTestCheckFour_(c, data, withFormulas) {
  var counts = { withQuote: 0, withoutQuote: 0 };
  SELFTEST_FOUR.forEach(function (name) {
    var exp = data.tables[name];
    var sheet = c.ss.getSheetByName(name);
    var actual = sheet ? selfTestSheetText_(sheet) : [];
    if (name === '取り込み結果') actual = selfTestTablePart_(actual);
    var cmp = compareTables(exp.rows, actual, { name: name, guarded: exp.guarded });
    c.checkTable(name, cmp);
    counts.withQuote += cmp.guardedWithQuote;
    counts.withoutQuote += cmp.guardedWithoutQuote;
    if (!withFormulas) return;
    Object.keys(exp.guarded).forEach(function (key) {
      var rc = key.split(',').map(Number);
      var cell = name + ' ' + columnLetter(rc[1]) + rc[0];
      var formula = sheet && sheet.getLastRow() >= rc[0] && sheet.getLastColumn() >= rc[1] ? sheet.getRange(rc[0], rc[1]).getFormulas()[0][0] : null;
      c.check(cell + ' の数式', formula === '', formula === null ? cell + ' がありません' : cell + ' が数式です: ' + formula);
    });
  });
  return counts;
}

/** 4 つの表のケース（C12・C13・C19 の共通部分）。extra: 表の前に足す確かめる数 */
function selfTestFourCase_(c, caseName, overrides, extra) {
  var data = selfTestFour_(c, caseName);
  if (!data) return null;
  c.expect(data.cells + 4 + 1 + 1 + (extra || 0));
  var run = selfTestRunCase_(c, caseName, overrides);
  if (!run) return null;
  selfTestCheckStatus_(c, run.result, 'success');
  c.addChecks(rebuiltCheck(run.before, run.after, false));
  selfTestCheckSet_(c, 'four');
  selfTestCheckFour_(c, data, false);
  return { data: data, run: run };
}

/** 「エラー」だけになるケース（C14〜C17）。label は 2 回流す項目で詳細の場所に付ける */
function selfTestErrorCase_(c, caseName, overrides, exp, label) {
  var run = selfTestRunCase_(c, caseName, overrides);
  if (!run) return null;
  var before = c.checks.length;
  selfTestCheckStatus_(c, run.result, 'inputError');
  c.addChecks(rebuiltCheck(run.before, run.after, false));
  selfTestCheckSet_(c, 'error');
  var sheet = c.ss.getSheetByName('エラー');
  var actual = sheet ? selfTestTablePart_(selfTestSheetText_(sheet)) : [];
  c.checkTable('エラー', compareTables(exp.rows, actual, { name: label ? 'エラー（' + label + '）' : 'エラー', guarded: exp.guarded }));
  if (label) {
    for (var i = before; i < c.checks.length; i++) {
      if (c.checks[i].detail) c.checks[i].detail = label + ': ' + c.checks[i].detail;
    }
  }
  return run;
}

/** 01 の input のファイルの更新日時と大きさ: { 名前: { updated, size } } */
function selfTestInputSnapshot_(c, caseName) {
  var kase = selfTestCase_(c, caseName);
  var out = {};
  if (kase.error) return out;
  var it = kase.input.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) out[f.getName()] = { updated: f.getLastUpdated().getTime(), size: f.getSize() };
  }
  return out;
}

function selfTestWorkSheet_(c) {
  var left = c.ss.getSheetByName(SELFTEST_WORK_SHEET);
  if (left) c.ss.deleteSheet(left);
  return c.ss.insertSheet(SELFTEST_WORK_SHEET, c.ss.getSheets().length);
}

function selfTestDropWorkSheet_(c) {
  c.cleanup(function () {
    var sheet = c.ss.getSheetByName(SELFTEST_WORK_SHEET);
    if (sheet) c.ss.deleteSheet(sheet);
  });
}

/** 文字のコード（U+xxxx） */
function selfTestCodeOf_(s, index) {
  if (typeof s !== 'string' || index >= s.length) return '文字なし';
  return 'U+' + ('000' + s.charCodeAt(index).toString(16).toUpperCase()).slice(-4);
}

// ---- 項目（5.1） ----

function selfTestC01_(c) {
  var data = selfTestFour_(c, '01-basic');
  if (!data) return;
  c.state.c07Before = selfTestInputSnapshot_(c, '01-basic');
  c.expect(data.cells + 4 + 1 + 1 + data.guardedCount);
  var run = selfTestRunCase_(c, '01-basic', {});
  if (!run) return;
  c.state.c01Success = run.result.status === 'success';
  selfTestCheckStatus_(c, run.result, 'success');
  c.addChecks(rebuiltCheck(run.before, run.after, false));
  selfTestCheckSet_(c, 'four');
  c.state.guardCounts = selfTestCheckFour_(c, data, true);
}

function selfTestC02_(c) {
  if (!c.state.c01Success) return c.notRun(SELFTEST_C01_FAILED);
  var exp = selfTestExpected_(c, '01-basic', 'details.csv', '明細');
  if (!exp) return;
  c.expect(2);
  var sheet = c.ss.getSheetByName('明細');
  var actual = sheet ? selfTestSheetText_(sheet) : [];
  [['ギフトセット ①', '①'], ['㈱サンプル焙煎所 特製ブレンド', '㈱']].forEach(function (pair) {
    var row = -1;
    for (var i = 1; i < exp.raw.length && row === -1; i++) if (exp.raw[i][3] === pair[0]) row = i;
    if (row === -1) return; // 期待値に見つからなかった文字は確かめた数に入れない（任意 2）
    var a = actual[row] && actual[row][3] !== undefined ? actual[row][3] : '';
    var cell = '明細 D' + (row + 1);
    c.check(cell, a === pair[0], cell + ': 期待「' + pair[0] + '」実際「' + a + '」（' + pair[1] + ' の位置: ' + selfTestCodeOf_(a, pair[0].indexOf(pair[1])) + '）');
  });
}

function selfTestC03_(c) {
  if (!c.state.c01Success) return c.notRun(SELFTEST_C01_FAILED);
  var exp = selfTestExpected_(c, '01-basic', 'details.csv', '明細');
  if (!exp) return;
  var rows = [];
  exp.raw.forEach(function (r, i) { if (i > 0 && r[3] === '=SUM(1,2)') rows.push(i + 1); });
  if (rows.length !== 1) return c.notRun('実施できません: 期待値の明細の =SUM(1,2) の行が ' + rows.length + ' 行です（1 行のはず）');
  c.expect(3);
  var r = rows[0];
  var sheet = c.ss.getSheetByName('明細');
  if (!sheet || sheet.getLastRow() < r) {
    c.check('明細 D' + r, false, '明細 D' + r + ' がありません');
    return;
  }
  var cell = sheet.getRange(r, 4);
  var formula = cell.getFormulas()[0][0];
  c.check('getFormulas', formula === '', '明細 D' + r + ' が数式です: ' + formula);
  var work = selfTestWorkSheet_(c);
  try {
    work.getRange(1, 1).setFormula('=ISFORMULA(明細!D' + r + ')');
    work.getRange(1, 2).setFormula('=LEN(明細!D' + r + ')');
    SpreadsheetApp.flush();
    var isFormula = work.getRange(1, 1).getValue();
    var len = work.getRange(1, 2).getValue();
    c.check('ISFORMULA', isFormula === false, '=ISFORMULA(明細!D' + r + ') が「' + String(isFormula) + '」（期待 FALSE）');
    var written = buildDetailValues([{ ym: '2026-10', ymd: '2026-10-02', orderId: 'A-1015', product: '=SUM(1,2)', quantity: 1, amount: 100, file: 'c_2026-09-to-10.csv', line: 7 }], FORMULA_GUARD)[1][3];
    var want = FORMULA_GUARD ? "'=SUM(1,2)" : '=SUM(1,2)';
    c.check('書いた値', written === want, '本番が書く値が「' + written + '」（期待「' + want + '」）');
    var g = c.state.guardCounts;
    var guardText = !g ? '守ったセルの数は C01 から取れません'
      : g.withQuote > 0 && g.withoutQuote > 0 ? "守ったセル ' あり " + g.withQuote + '・なし ' + g.withoutQuote + '（混ざっている）'
      : "守ったセル ' あり " + g.withQuote + '・なし ' + g.withoutQuote;
    c.note('ISFORMULA=' + String(isFormula).toUpperCase() + '、LEN=' + String(len) + '、見た目「' + cell.getDisplayValue() + '」、書いた値「' + written + '」、' + guardText);
  } finally {
    selfTestDropWorkSheet_(c);
  }
}

function selfTestC04_(c) {
  if (!c.state.c01Success) return c.notRun(SELFTEST_C01_FAILED);
  c.expect(4);
  var sheet = c.ss.getSheetByName('取り込み結果');
  var rows = sheet ? selfTestSheetText_(sheet) : [];
  var at = -1;
  for (var i = 0; i < rows.length && at === -1; i++) if (rows[i][0] === '読まなかったファイル') at = i;
  var get = function (r, col) { return rows[r] && rows[r][col] !== undefined ? rows[r][col] : ''; };
  c.check('「読まなかったファイル」の行', at !== -1, '取り込み結果に「読まなかったファイル」の行がありません');
  var count = at === -1 ? '' : get(at, 1);
  c.check('件数', count === '2 件', '「読まなかったファイル」が「' + count + '」（期待「2 件」）');
  ['memo.txt', '~$a_2026-08.csv'].forEach(function (name, k) {
    var v = at === -1 ? '' : get(at + 1 + k, 1);
    c.check(name, at !== -1 && v === name, '取り込み結果 B' + (at + 2 + k) + ': 期待「' + name + '」実際「' + v + '」');
  });
}

/** C05（再実行）。C06（=集計!D2 の記録）も同じ関数で実施する */
function selfTestC05_(c) {
  if (!c.state.c01Success) return c.notRun(SELFTEST_C01_FAILED);
  var data = selfTestFour_(c, '01-basic');
  if (!data) return;
  c.expect(data.cells + 4 + 1 + 1 + 1);
  var work = selfTestWorkSheet_(c);
  try {
    work.getRange(1, 1).setFormula('=集計!D2');
    SpreadsheetApp.flush();
    var count = c.ss.getSheets().length;
    var run = selfTestRunCase_(c, '01-basic', {});
    if (!run) return;
    c.state.c05Ran = true;
    SpreadsheetApp.flush();
    try {
      c.recordFor('C06', '実行のあとの表示「' + work.getRange(1, 1).getDisplayValue() + '」（#REF! なら参照が切れる。README の「出力のシートについて」を直す）');
    } catch (e) {
      c.recordFor('C06', '記録できず（例外: ' + selfTestMessage_(e) + '）');
    }
    selfTestCheckStatus_(c, run.result, 'success');
    c.addChecks(rebuiltCheck(run.before, run.after, false));
    selfTestCheckSet_(c, 'four');
    selfTestCheckFour_(c, data, false);
    var after = c.ss.getSheets().length;
    c.check('シートの数', after === count, 'スプレッドシートのシートの数が ' + count + ' → ' + after);
  } finally {
    selfTestDropWorkSheet_(c);
  }
}

function selfTestC07_(c) {
  var before = c.state.c07Before;
  if (!before) return c.notRun('実施できません: C01 の前に更新日時と大きさを控えられなかったため');
  if (!c.state.c05Ran) return c.notRun('実施できません: C05 を実施できなかったため');
  var names = Object.keys(CASE_FILES['01-basic']).filter(function (p) { return p.indexOf('input/') === 0; }).map(function (p) { return p.slice(6); });
  c.expect(names.length * 2);
  var now = selfTestInputSnapshot_(c, '01-basic');
  names.forEach(function (name) {
    var b = before[name];
    var a = now[name];
    if (!b || !a) {
      // 前か後のどちらかで見つからない（消えた・ゴミ箱に入った）のは違い。数えずに未実施にしない（tester 2026-10-18）
      var where = !b ? 'C01 の前' : 'C05 のあと';
      c.check(name + ' の更新日時', false, name + ' が ' + where + 'にありません');
      c.check(name + ' の大きさ', false, name + ' が ' + where + 'にありません');
      return;
    }
    c.check(name + ' の更新日時', a.updated === b.updated, name + ' の更新日時が変わりました');
    c.check(name + ' の大きさ', a.size === b.size, name + ' の大きさが ' + b.size + ' → ' + a.size);
  });
}

function selfTestC08_(c) {
  c.expect(7);
  var saved = SJIS_CHARSET;
  var run;
  try {
    SJIS_CHARSET = 'Shift_JIS'; // コードは直さず、グローバルの値だけを一時的に変える
    run = selfTestRunCase_(c, '01-basic', {});
  } finally {
    SJIS_CHARSET = saved;
    if (SJIS_CHARSET !== saved) c.run.cleanupError = c.run.cleanupError || 'SJIS_CHARSET を元に戻せませんでした';
  }
  if (!run) return;
  selfTestCheckStatus_(c, run.result, 'inputError');
  c.addChecks(rebuiltCheck(run.before, run.after, false));
  selfTestCheckSet_(c, 'error');
  var sheet = c.ss.getSheetByName('エラー');
  var rows = sheet ? selfTestTablePart_(selfTestSheetText_(sheet)).slice(1) : [];
  c.check('エラーの行の数', rows.length === 1, 'エラーの表のデータの行が ' + rows.length + ' 行（期待 1 行）');
  var r = rows[0] || [];
  c.check('ファイル', r[0] === 'a_2026-08.csv', 'エラー A2: 期待「a_2026-08.csv」実際「' + (r[0] || '') + '」');
  c.check('行', r[1] === '4', 'エラー B2: 期待「4」実際「' + (r[1] || '') + '」');
  c.check('内容', r[2] === SELFTEST_DECODE_MESSAGE, 'エラー C2: 期待「' + SELFTEST_DECODE_MESSAGE + '」実際「' + (r[2] || '') + '」');
  if (run.result.status !== 'inputError') {
    var details = c.ss.getSheetByName('明細');
    var code = '明細なし';
    if (details) {
      selfTestSheetText_(details).forEach(function (row) {
        if (/^ギフトセット [^\n]$/.test(row[3] || '')) code = selfTestCodeOf_(row[3], 7);
      });
    }
    c.note('明細の ① の位置の文字: ' + code);
  }
}

function selfTestC09_(c) {
  c.expect(7);
  var run = selfTestRunCase_(c, '01-basic', { ENCODING: 'UTF-8' });
  if (!run) return;
  selfTestCheckStatus_(c, run.result, 'inputError');
  c.addChecks(rebuiltCheck(run.before, run.after, false));
  var sheet = c.ss.getSheetByName('エラー');
  var rows = sheet ? selfTestTablePart_(selfTestSheetText_(sheet)).slice(1) : [];
  var aRows = rows.filter(function (r) { return r[0] === 'a_2026-08.csv'; });
  c.check('a_2026-08.csv の行の数', aRows.length === 1, 'a_2026-08.csv の行が ' + aRows.length + ' 行（期待 1 行）');
  var r = aRows[0] || [];
  c.check('ファイル', r[0] === 'a_2026-08.csv', 'a_2026-08.csv の行がありません');
  c.check('行', r[1] === '1', 'a_2026-08.csv の行の番号: 期待「1」実際「' + (r[1] || '') + '」');
  c.check('内容', r[2] === SELFTEST_DECODE_MESSAGE, 'a_2026-08.csv の内容: 期待「' + SELFTEST_DECODE_MESSAGE + '」実際「' + (r[2] || '') + '」');
  c.check('見出しにありません', !rows.some(function (x) { return /見出しにありません/.test(x[2] || ''); }), '「見出しにありません」の行があります');
}

function selfTestC10_(c) {
  var ss = c.ss;
  var kase = selfTestCase_(c, '01-basic');
  if (kase.error) return c.notRun('実施できません: ' + kase.error);
  var existing = ss.getSheetByName('明細');
  if (existing) {
    var lastColumn = existing.getLastColumn();
    var header = lastColumn > 0 ? existing.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
    if (existing.getLastRow() !== 0 && !isOwnOutputSheet('明細', header)) {
      return c.notRun('実施できません: 「明細」シートが本番のツールのものではありません（名前を変えてから押してください）');
    }
    ss.deleteSheet(existing);
  }
  var blank = ss.insertSheet('明細', ss.getSheets().length);
  var id = blank.getSheetId();
  try {
    // 空の「明細」を作ったあとに控える（作る前に控えると、自分で作った「明細」が「変わった」と数えられる。任意 1）
    var before = selfTestOutputs_(ss);
    c.expect(3 + selfTestStoppedCount_(before));
    var run = selfTestRunCase_(c, '01-basic', {});
    if (!run) return;
    selfTestCheckStatus_(c, run.result, 'stopped');
    // 期待する文は自己テストに書いた SELFTEST_FOREIGN_MESSAGE（本番の foreignSheetMessage で作らない。4.5）
    c.check('文', String(run.result.message).indexOf(SELFTEST_FOREIGN_MESSAGE) !== -1, '文に「' + SELFTEST_FOREIGN_MESSAGE.slice(0, 40) + '…」がありません: ' + String(run.result.message).slice(0, 120));
    var still = selfTestSheetById_(ss, id);
    c.check('空の「明細」', !!still && still.getLastRow() === 0, still ? '空の「明細」に書かれました' : '空の「明細」が消えました');
    c.addChecks(rebuiltCheck(before, run.after, true));
  } finally {
    c.cleanup(function () {
      var sheet = selfTestSheetById_(ss, id);
      if (sheet) ss.deleteSheet(sheet);
    });
  }
}

function selfTestC11_(c) {
  var exp = selfTestExpected_(c, '02-errors', 'errors.csv', 'エラー');
  if (!exp) return;
  c.expect(1 + 1 + 1 + 1 + 4 + exp.cells);
  var prep = selfTestRunCase_(c, '01-basic', {});
  if (!prep) return;
  var ok = prep.result.status === 'success';
  c.check('準備の 01', ok, '準備の 01 が成功しませんでした（status「' + prep.result.status + '」）');
  if (!ok) return;
  var ids = SELFTEST_FOUR.map(function (name) { var s = c.ss.getSheetByName(name); return s ? s.getSheetId() : null; });
  var run = selfTestErrorCase_(c, '02-errors', {}, exp, '');
  if (!run) return;
  SELFTEST_FOUR.forEach(function (name, i) {
    c.check(name + ' が消えた', ids[i] !== null && !selfTestSheetById_(c.ss, ids[i]), '前の集計の「' + name + '」が残っています');
  });
}

function selfTestC12_(c) {
  selfTestFourCase_(c, '03-no-dedupe', {}, 0);
}

function selfTestC13_(c) {
  var kase = selfTestCase_(c, '03-no-dedupe');
  if (kase.error) return c.notRun('実施できません: ' + kase.error);
  // expected と直接比べる（C12 の結果とは比べない）。止まって C12 のシートが残っただけなら、作り直しの確認で ×
  selfTestFourCase_(c, '03-no-dedupe', { CSV_FOLDER: ' https://drive.google.com/drive/folders/' + kase.inputId + '?usp=sharing　' }, 0);
}

function selfTestC14_(c) {
  var exp = selfTestExpected_(c, '04-unclosed-one-file', 'errors.csv', 'エラー');
  if (!exp) return;
  c.expect(exp.cells + 3);
  selfTestErrorCase_(c, '04-unclosed-one-file', {}, exp, '');
}

function selfTestC15_(c) {
  var exp = selfTestExpected_(c, '05-stray-quotes', 'errors.csv', 'エラー');
  if (!exp) return;
  c.expect(exp.cells + 3);
  selfTestErrorCase_(c, '05-stray-quotes', {}, exp, '');
}

function selfTestC16_(c) {
  var exp = selfTestExpected_(c, '05-stray-quotes', 'errors.csv', 'エラー', [0, 1, 3]);
  if (!exp) return;
  if (exp.raw.length !== 3) return c.notRun('実施できません: 05 の期待値の行が足りません');
  c.expect(exp.cells + 3);
  selfTestErrorCase_(c, '05-stray-quotes', { QUOTE_CHECK: 'FALSE' }, exp, '');
}

function selfTestC17_(c) {
  var exp = selfTestExpected_(c, '05-stray-quotes', 'errors.csv', 'エラー');
  if (!exp) return;
  c.expect((exp.cells + 3) * 2);
  if (!selfTestErrorCase_(c, '05-stray-quotes', { QUOTE_CHECK: undefined }, exp, '行なし')) return;
  if (!selfTestErrorCase_(c, '05-stray-quotes', { QUOTE_CHECK: ' 　' }, exp, '空白だけ')) return;
  c.state.c17Ran = true;
}

function selfTestC18_(c) {
  if (!c.state.c17Ran) return c.notRun('実施できません: 同じ回に C17 を実施できなかったため');
  var kase = selfTestCase_(c, '05-stray-quotes');
  if (kase.error) return c.notRun('実施できません: ' + kase.error);
  var before = selfTestOutputs_(c.ss);
  if (before.length === 0) return c.notRun('実施できません: 実行の前に出力のシートがありません');
  c.expect(2 + selfTestStoppedCount_(before));
  var run = selfTestRunCase_(c, '05-stray-quotes', { QUOTE_CHECK: 'abc' });
  if (!run) return;
  selfTestCheckStatus_(c, run.result, 'stopped');
  var want = '・QUOTE_CHECK は TRUE か FALSE にしてください';
  c.check('文', String(run.result.message).indexOf(want) !== -1, '文に「' + want + '」がありません: ' + String(run.result.message).slice(0, 120));
  c.addChecks(rebuiltCheck(before, run.after, true));
}

function selfTestC19_(c) {
  var details = selfTestExpected_(c, '06-sjis-fixed-decimal', 'details.csv', '明細');
  var summary = details ? selfTestExpected_(c, '06-sjis-fixed-decimal', 'summary.csv', '集計') : null;
  if (!summary) return;
  var detailRows = details.raw.length - 1;
  var summaryRows = summary.raw.length - 1;
  var done = selfTestFourCase_(c, '06-sjis-fixed-decimal', {}, detailRows + summaryRows);
  if (!done) return;
  [['明細', 6, detailRows], ['集計', 4, summaryRows]].forEach(function (t) {
    var sheet = c.ss.getSheetByName(t[0]);
    var formats = sheet && sheet.getLastRow() >= t[2] + 1 ? sheet.getRange(2, t[1], t[2], 1).getNumberFormats() : [];
    for (var i = 0; i < t[2]; i++) {
      var f = formats[i] ? formats[i][0] : '（なし）';
      var cell = t[0] + ' ' + columnLetter(t[1]) + (i + 2);
      c.check(cell + ' の書式', f === '#,##0.00', cell + ' の書式が「' + f + '」（期待「#,##0.00」）');
    }
  });
}

/** C20・C21: 作業用シートに本番の書き方で 5 つの値を書き、数式・ISFORMULA・LEN・値を読む */
function selfTestFormulaRows_(c, guard) {
  var details = SELFTEST_FORMULA_VALUES.map(function (v, i) {
    return { ym: '2026-10', ymd: '2026-10-01', orderId: 'A-' + (i + 1), product: v, quantity: 1, amount: 100, file: 'selftest.csv', line: i + 2 };
  });
  var sheet = selfTestWorkSheet_(c);
  writeTable_(sheet, { name: '明細', values: buildDetailValues(details, guard), tableRows: details.length });
  if (sheet.getMaxColumns() < 9) sheet.insertColumnsAfter(sheet.getMaxColumns(), 9 - sheet.getMaxColumns());
  details.forEach(function (d, i) {
    sheet.getRange(i + 2, 8).setFormula('=ISFORMULA(D' + (i + 2) + ')');
    sheet.getRange(i + 2, 9).setFormula('=LEN(D' + (i + 2) + ')');
  });
  SpreadsheetApp.flush();
  return details.map(function (d, i) {
    var r = i + 2;
    var value = sheet.getRange(r, 4).getValues()[0][0];
    return {
      value: d.product,
      formula: sheet.getRange(r, 4).getFormulas()[0][0],
      isFormula: sheet.getRange(r, 8).getValue(),
      len: sheet.getRange(r, 9).getValue(),
      actual: value === null || value === undefined ? '' : String(value),
    };
  });
}

function selfTestC20_(c) {
  c.expect(SELFTEST_FORMULA_VALUES.length * 3);
  try {
    var rows = selfTestFormulaRows_(c, FORMULA_GUARD);
    rows.forEach(function (x, i) {
      var cell = 'D' + (i + 2);
      var guarded = selfTestGuardText_(x.value, FORMULA_GUARD) !== x.value;
      c.check(cell + ' の数式', x.formula === '', cell + '（' + x.value + '）が数式です: ' + x.formula);
      c.check(cell + ' の ISFORMULA', x.isFormula === false, cell + '（' + x.value + '）の ISFORMULA が「' + String(x.isFormula) + '」');
      c.check(cell + ' の値', x.actual === x.value || (guarded && x.actual === "'" + x.value), cell + ': 期待「' + x.value + '」実際「' + x.actual + '」');
    });
    c.note('LEN: ' + rows.map(function (x) { return x.value + '→' + String(x.len); }).join('、'));
  } finally {
    selfTestDropWorkSheet_(c);
  }
}

function selfTestC21_(c) {
  try {
    var rows = selfTestFormulaRows_(c, false);
    c.record(rows.map(function (x) {
      return '「' + x.value + '」は' + (x.formula === '' ? '数式なし' : '数式あり') + '・ISFORMULA=' + String(x.isFormula).toUpperCase() + '・LEN=' + String(x.len) + '・値「' + x.actual + '」';
    }).join('、'));
  } finally {
    selfTestDropWorkSheet_(c);
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    SELFTEST_VERSION: SELFTEST_VERSION,
    SELFTEST_HEADERS: SELFTEST_HEADERS,
    SELFTEST_LIMIT_MS: SELFTEST_LIMIT_MS,
    SELFTEST_RESUME_MS: SELFTEST_RESUME_MS,
    SELFTEST_M03_TEXT: SELFTEST_M03_TEXT,
    SELFTEST_PLAN: SELFTEST_PLAN,
    SELFTEST_MANUAL: SELFTEST_MANUAL,
    SELFTEST_FINGERPRINT_FUNCS: SELFTEST_FINGERPRINT_FUNCS,
    SELFTEST_FINGERPRINT_VARS: SELFTEST_FINGERPRINT_VARS,
    SELFTEST_OUTPUT_SHEETS: SELFTEST_OUTPUT_SHEETS,
    SELFTEST_DECODE_MESSAGE: SELFTEST_DECODE_MESSAGE,
    SELFTEST_FOREIGN_MESSAGE: SELFTEST_FOREIGN_MESSAGE,
    CASE_FILES: CASE_FILES,
    columnLetter: columnLetter,
    compareTables: compareTables,
    formatDiffs: formatDiffs,
    itemResult: itemResult,
    rebuiltCheck: rebuiltCheck,
    expectedWithGuard: expectedWithGuard,
    overallResult: overallResult,
    buildSelfTestValues: buildSelfTestValues,
    resumePoint: resumePoint,
    codeFingerprint: codeFingerprint,
    fingerprintSources: fingerprintSources,
    checkUploadedFiles: checkUploadedFiles,
    selfTestInfoRows_: selfTestInfoRows_,
    selfTestRestartText_: selfTestRestartText_,
    selfTestSafeText_: selfTestSafeText_,
    selfTestGuardText_: selfTestGuardText_,
    selfTestFinalMessage_: selfTestFinalMessage_,
  };
}
