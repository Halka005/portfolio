/**
 * 自己テスト（開発用。**納品物には入れない**）。仕様: docs/specs/selftest.md（版 5）
 * テスト専用のスプレッドシート（名前が「自己テスト」で始まる）で、メニュー「請求書ツール」→「自己テスト（開発用）」から動かす。
 * サンプルデータを本番の処理（runInvoicesWith_）に流し、結果を「自己テスト」シートに ○ / × / 未実施で書く。
 * 「設定」シートは読まない（前後で同じかを B06 で見るだけ）・書かない。Gmail は呼ばない（どの項目も「顧客」のメールアドレスを空にして流す。B05 は流す前に読み直して確かめる）。
 * ドライブには確認用 PDF（マイドライブ）と、フォルダ「自己テスト_請求書」と中の PDF ができる。自動では消さない（仕様 6.4）。
 *
 * 期待値（金額・番号・ファイル名・文）は、数字と文字をこのファイルに直接書く。本番の関数（calcInvoice・formatYen・
 * nextInvoiceNumber など）で作らない。本番の誤りが期待値にも入り、偽の ○ になるため（仕様 4.5、docs/LESSONS.md 2026-10-18）。
 * 例外は B05 の守りの isValidEmail だけ（仕様 4.5 の表）。
 *
 * 上に純粋関数（Node.js から require して単体テストする）、下に GAS の処理。
 * 最上位の var は定数だけにする（コードの指紋に入るため。仕様 8.3）。最上位で他のファイルの名前を使わない。
 * 続き（時間で止まったときの続きから）は入れない。毎回、最初から実施する（仕様 6.5）。
 */

var SELFTEST_VERSION = '2026-10-19';
var SELFTEST_SHEET = '自己テスト';
var SELFTEST_NAME_PREFIX = '自己テスト';
var SELFTEST_HEADERS = ['番号', '区分', '項目', '結果', '詳細', '秒', '回'];
var SELFTEST_COLOR_HEADER = '#e0e0e0';
var SELFTEST_COLOR_INPUT = '#fff8c5';
var SELFTEST_COLOR_RED = '#c62828';
var SELFTEST_NAME_MESSAGE = 'このスプレッドシートの名前が「自己テスト」で始まっていないので、止めました。自己テストは、本番のデータを消さないように、テスト専用のスプレッドシートでだけ動きます。新しいスプレッドシートを作り、名前を「自己テスト_請求書」のようにしてから実行してください。';
var SELFTEST_MANUAL_STOP_MESSAGE = '「自己テスト」シートの M01・M02 に書き込みがあるので、止めました。書き込みを別に控えてから、「自己テスト」シートを消して、もう一度押してください。';
var SELFTEST_M03_TEXT = 'ここには書かないでください。確かめたものは、README 9 章の行ごとに、何を見てどうだったかを別に送ってください';
var SELFTEST_NOT_YET = '時間: まだ実施していません';
var SELFTEST_B01_FAILED = '実施できません: DRY_RUN が TRUE でないので止めました';

// 本番の処理に渡す入力（5.2）。runInvoicesWith_ は正規化した形（'202610'）で受け取る（推奨 4）
var SELFTEST_YEAR_MONTH = '202610';
var SELFTEST_SAMPLE_MONTH = '2026-10';
var SELFTEST_ISSUE_DATE = [2026, 9, 31]; // 発行日 2026年10月31日（new Date(y, m, d) の引数）。支払期限は 2026年11月30日
var SELFTEST_FOLDER_NAME = '自己テスト_請求書';
var SELFTEST_CONFIG_SHEET = '設定';
// 作り直すシートの見出し。本番の HEADERS を使わずに書く（仕様 4.5）
var SELFTEST_TABLE_HEADERS = {
  '顧客': ['顧客ID', '会社名', '敬称', '担当者名', 'メールアドレス'],
  '請求明細': ['請求月', '顧客ID', '品目', '数量', '単価', '税率'],
  '発行履歴': ['請求月', '顧客ID', '請求書番号', '請求金額', 'PDF', 'Gmail下書き', '作成日時'],
  'ログ': ['日時', 'レベル', '内容'],
};

// 期待値（数字と文字で書く。calcInvoice・formatYen で計算し直さない。C002 は director が確定。仕様 5.2）
var SELFTEST_INVOICES = [
  { customerId: 'C001', number: 'INV-202610-001', total: 49500, previewName: '[確認用]INV-202610-001_株式会社サンプル商事.pdf' },
  { customerId: 'C002', number: 'INV-202610-002', total: 7766, previewName: '[確認用]INV-202610-002_テスト合同会社.pdf' },
];
var SELFTEST_LINE_C001 = '確認用 PDF: 株式会社サンプル商事 ¥49,500';
var SELFTEST_LINE_C002 = '確認用 PDF: テスト合同会社 ¥7,766';
var SELFTEST_LINE_SKIPPED = 'スキップ（発行済み）: 株式会社サンプル商事';
var SELFTEST_HEAD_DRY_RUN = '【お試しモード】';
var SELFTEST_HEAD_ISSUED = '請求書を作成しました';
var SELFTEST_LOG_PREVIEW = '[DRY_RUN] 確認用 PDF を作成: ';
var SELFTEST_DRAFT_NONE = '未作成';
var SELFTEST_PDF_MIME = 'application/pdf';

// 実行の順（5.2）。needs: 前提の項目（○ でなければ流さない）、by: 別の項目の関数の中で確かめる項目
var SELFTEST_PLAN = [
  { id: 'B01', kind: '判定', title: '初期値の DRY_RUN が TRUE（DRY_RUN）', run: selfTestB01_ },
  { id: 'B02', kind: '判定', title: 'DRY_RUN でサンプルの 2 社（¥49,500・¥7,766）。下書きと発行履歴を作らない', run: selfTestB02_, needs: 'B01' },
  { id: 'B03', kind: '判定', title: '確認用 PDF ができた（PDF 作成。番号 001・002）', run: null, by: 'B02', needs: 'B01' },
  { id: 'B04', kind: '判定', title: 'DRY_RUN で、発行履歴にある顧客はスキップ（二重発行の防止）', run: selfTestB04_, needs: 'B01' },
  { id: 'B05', kind: '判定', title: '本番モード（メールアドレスを空にして下書きなし）で 2 回実行しても二重に発行しない', run: selfTestB05_, needs: 'B01' },
  { id: 'B06', kind: '判定', title: '「設定」シートを変えていない', run: selfTestB06_ },
];

// 手で確認（5.4）
var SELFTEST_MANUAL = [
  { id: 'M01', title: '本番のメニュー（README の手順）: 別のスプレッドシート「本番確認_請求書」に、自己テストと同じ ZIP の main.js・lib.js・appsscript.json だけを貼る。E 列に (1) メニューの項目 (2) 文が「【お試しモード】」で始まり、株式会社サンプル商事 ¥49,500 とテスト合同会社 ¥7,766 の行があるか (3) 「発行履歴」が見出しだけのままか (4) Gmail の下書きが増えていないか (5) ZIP をダウンロードした日' },
  { id: 'M02', title: '承認画面の文（自己テストのときと M01 のとき）。E 列に書き写すか、スクリーンショットを添える。自分のメールアドレスと名前は書かない' },
  { id: 'M03', title: '任意の手で確認（手順は README 9 章）: 確認用 PDF を開いて見た目と金額を見る／作られた PDF とフォルダは不要なら手で消してよい／下書きの経路（自分宛てで作り、送らずに消す）' },
];

// コードの指紋に入れる名前（8.3）。main.js・lib.js・selftest.js の最上位の関数と var の全部を、名前の順に。
// 手で数えない。tests/selftest.test.js がファイルの中身とちょうど一致するかを確かめる
var SELFTEST_FINGERPRINT_FUNCS = [
  'appendRows_',
  'buildSelfTestValues',
  'calcDueDate',
  'calcInvoice',
  'codeFingerprint',
  'columnLetter',
  'compareTables',
  'createInvoices',
  'createTableSheet_',
  'displayYm_',
  'escapeHtml',
  'fingerprintSources',
  'formatDateJa',
  'formatDiffs',
  'formatYen',
  'getFolder_',
  'groupByCustomer',
  'insertSampleData',
  'isValidEmail',
  'isValidRegistrationNumber',
  'itemResult',
  'loadConfig_',
  'log_',
  'nextInvoiceNumber',
  'normalizeYearMonth',
  'onOpen',
  'overallResult',
  'parseConfigRows',
  'readTable_',
  'renderInvoiceHtml',
  'renderTemplate',
  'roundYen',
  'runInvoices',
  'runInvoicesWith_',
  'runSelfTest',
  'safeFileName',
  'sampleData',
  'selfTestB01_',
  'selfTestB02_',
  'selfTestB04_',
  'selfTestB05_',
  'selfTestB06_',
  'selfTestCheckLine_',
  'selfTestCheckPdf_',
  'selfTestCheckReturn_',
  'selfTestDryRunConfig_',
  'selfTestEmailCells_',
  'selfTestFinalMessage_',
  'selfTestFinish_',
  'selfTestFolder_',
  'selfTestHasOwn_',
  'selfTestInFolder_',
  'selfTestInfoRows_',
  'selfTestItemContext_',
  'selfTestLocked_',
  'selfTestLogAdded_',
  'selfTestLogCount_',
  'selfTestMessage_',
  'selfTestPdfId_',
  'selfTestPrepareSheet_',
  'selfTestReason_',
  'selfTestRebuildSheet_',
  'selfTestResetSheets_',
  'selfTestRunInvoices_',
  'selfTestRunItem_',
  'selfTestSafeText_',
  'selfTestSeconds_',
  'selfTestSetWithSubs_',
  'selfTestSheetText_',
  'selfTestUrlShape_',
  'selfTestValues_',
  'selfTestWrite_',
  'selfTest_',
  'setConfigValue_',
  'setup',
  'styleHeader_',
  'validateItems',
];
var SELFTEST_FINGERPRINT_VARS = [
  'COLOR_HEADER',
  'COLOR_INPUT',
  'DEFAULT_CONFIG',
  'HEADERS',
  'REQUIRED_KEYS',
  'SELFTEST_B01_FAILED',
  'SELFTEST_COLOR_HEADER',
  'SELFTEST_COLOR_INPUT',
  'SELFTEST_COLOR_RED',
  'SELFTEST_CONFIG_SHEET',
  'SELFTEST_DRAFT_NONE',
  'SELFTEST_FINGERPRINT_FUNCS',
  'SELFTEST_FINGERPRINT_VARS',
  'SELFTEST_FOLDER_NAME',
  'SELFTEST_HEADERS',
  'SELFTEST_HEAD_DRY_RUN',
  'SELFTEST_HEAD_ISSUED',
  'SELFTEST_INVOICES',
  'SELFTEST_ISSUE_DATE',
  'SELFTEST_LINE_C001',
  'SELFTEST_LINE_C002',
  'SELFTEST_LINE_SKIPPED',
  'SELFTEST_LOG_PREVIEW',
  'SELFTEST_M03_TEXT',
  'SELFTEST_MANUAL',
  'SELFTEST_MANUAL_STOP_MESSAGE',
  'SELFTEST_NAME_MESSAGE',
  'SELFTEST_NAME_PREFIX',
  'SELFTEST_NOT_YET',
  'SELFTEST_PDF_MIME',
  'SELFTEST_PLAN',
  'SELFTEST_SAMPLE_MONTH',
  'SELFTEST_SHEET',
  'SELFTEST_TABLE_HEADERS',
  'SELFTEST_VERSION',
  'SELFTEST_YEAR_MONTH',
  'SHEET',
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
 * 2 次元の文字の配列を比べる（B06 で使う）。options: { name（diffs のセルの前に付ける） }
 * 戻り値: { expectedCount（期待値のセルの数）, compared（比べたセルの数）, diffs: [{ cell, expected, actual }] }
 */
function compareTables(expected, actual, options) {
  var opts = options || {};
  var prefix = opts.name ? opts.name + ' ' : '';
  var exp = expected || [];
  var act = actual || [];
  var expectedCount = 0;
  exp.forEach(function (row) { expectedCount += row.length; });
  var diffs = [];
  var compared = 0;
  if (exp.length !== act.length) diffs.push({ cell: prefix + '行の数', expected: String(exp.length), actual: String(act.length) });
  var rows = Math.min(exp.length, act.length);
  for (var i = 0; i < rows; i++) {
    var e = exp[i];
    var a = act[i];
    if (e.length !== a.length) diffs.push({ cell: prefix + (i + 1) + ' 行目の列の数', expected: String(e.length), actual: String(a.length) });
    var cols = Math.min(e.length, a.length);
    for (var j = 0; j < cols; j++) {
      compared++;
      if (String(a[j]) === String(e[j])) continue;
      diffs.push({ cell: prefix + columnLetter(j + 1) + (i + 1), expected: String(e[j]), actual: String(a[j]) });
    }
  }
  return { expectedCount: expectedCount, compared: compared, diffs: diffs };
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

/** 未実施の理由: 'time'（時間が足りない・実行中）か 'other' */
function selfTestReason_(item) {
  if (item.result === '実行中') return 'time';
  return String(item.detail || '').indexOf('時間:') === 0 ? 'time' : 'other';
}

/**
 * 全体の判定（6.1 の 6）。plan: 判定の項目の番号の一覧、results: { 番号: { result, detail } }（判定の項目だけ）
 * 請求書には続きがないので、時間による未実施の文は「最初から実施します」にする（6.5）。
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

  var unknown = list.filter(function (id) { return ['○', '×', '未実施', '実行中'].indexOf(res[id].result) === -1; });
  if (unknown.length > 0) return { result: '不合格', detail: '自己テストのコードの誤り: 結果の値が違います: ' + unknown.join('、') };
  var failed = list.filter(function (id) { return res[id].result === '×'; });
  var pending = list.filter(function (id) { return res[id].result === '未実施' || res[id].result === '実行中'; });
  var timePending = pending.filter(function (id) { return selfTestReason_(res[id]) === 'time'; });
  var otherPending = pending.length - timePending.length;
  if (failed.length > 0) {
    var text = '× が ' + failed.length + ' 件（番号: ' + failed.join('、') + '）';
    if (timePending.length > 0) text += '。未実施 ' + timePending.length + ' 件は、もう一度押すと最初から実施します';
    return { result: '不合格', detail: text };
  }
  if (pending.length > 0) {
    if (otherPending === 0) return { result: '未完了', detail: '未実施 ' + pending.length + ' 件。もう一度「自己テスト（開発用）」を押すと最初から実施します' };
    return { result: '未完了', detail: '未実施 ' + pending.length + ' 件のうち ' + otherPending + ' 件は、押し直しても実施できません（例: 前提の B01 が ○ でない）。この画面を送ってください' };
  }
  return { result: 'すべて合格', detail: '判定 ' + list.length + ' 件がすべて ○（自動の項目だけ）。本番のメニューでの確認（M01）と承認画面の文（M02）は、手で書いてから送ってください' };
}

/**
 * 最後の画面の文（7 章）。「未完了」のときは M01・M02 をまだ書かない（請求書は毎回作り直すので、書いてから押し直すと止まる。6.5）
 */
function selfTestFinalMessage_(overall) {
  var head = '自己テストの結果: ' + overall.result + '。' + selfTestSafeText_(overall.detail);
  if (overall.result === '未完了') return head + '\nM01・M02 はまだ書かないでください。';
  return head + '\nM01・M02 を書いてから「自己テスト」シートを送ってください。';
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
 * manual: [{ id, title, detail }]（M03 の E 列は決まった文）、info: [{ id, title, detail }]
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

/** I01〜I04 の行（4.2）。請求書は続きがないので、I03 はコードの指紋だけ、I04 は「なし」 */
function selfTestInfoRows_(at, version, spreadsheet, code) {
  return [
    { id: 'I01', title: '実行', detail: '1=' + at },
    { id: 'I02', title: '版', detail: 'SELFTEST_VERSION=' + version + ' / スプレッドシート=' + spreadsheet },
    { id: 'I03', title: '定数', detail: 'コード=' + code },
    { id: 'I04', title: 'やり直し', detail: 'なし' },
  ];
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
    // SELFTEST_PLAN の run のように値に関数があれば、名前を残す（どの関数を呼ぶかを変えても指紋が変わるように。仕様 8.3 版 4）
    sources.push('v:' + name + ':' + JSON.stringify(v, function (k, x) { return typeof x === 'function' ? 'function ' + x.name : x; }));
  });
  return { sources: sources, ok: ok };
}

/** PDF の URL（…/d/{ID}/…）からファイルの ID。取れなければ '' */
function selfTestPdfId_(url) {
  var m = /\/d\/([A-Za-z0-9_-]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

/** URL の形だけ（× の詳細に書く）。ホストを除き、長い英数字を {ID} にする（ID と URL を書かない。4.2） */
function selfTestUrlShape_(url) {
  var s = String(url || '').replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '').replace(/[A-Za-z0-9_-]{10,}/g, '{ID}');
  return s === '' ? '（空）' : s.slice(0, 60);
}

/**
 * B05 の守り（6.2）: 見出しを除くセルのうち、メールアドレスになりうるものの位置（'E2' など）。
 * 自己テスト側の決まり（@ を含む）と、本番が下書きを作るかを決める isValidEmail の両方で見る（仕様 4.5 の表の例外）。
 * isEmail: 本番の isValidEmail。@ を含まない文字はどれも isValidEmail が偽になることを tests/selftest.test.js で確かめる
 */
function selfTestEmailCells_(rows, isEmail) {
  var found = [];
  for (var i = 1; i < rows.length; i++) {
    for (var j = 0; j < rows[i].length; j++) {
      var v = rows[i][j] === null || rows[i][j] === undefined ? '' : String(rows[i][j]);
      if (v.indexOf('@') !== -1 || isEmail(v)) found.push(columnLetter(j + 1) + (i + 1));
    }
  }
  return found;
}

// ==================== GAS の処理 ====================

/** メニューから実行 */
function runSelfTest() {
  selfTest_();
}

/**
 * 本体。clock: 時刻を返す関数（ミリ秒）。省略時は Date.now。テストから時刻を決めるために渡す。
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
  var previousRows = [];
  if (existing) {
    var lastColumn = existing.getLastColumn();
    var header = lastColumn > 0 ? existing.getRange(1, 1, 1, lastColumn).getValues()[0].map(String) : [];
    if (header.join('\t') !== SELFTEST_HEADERS.join('\t')) {
      ui.alert('「自己テスト」シートが自己テストのものではありません（1 行目の見出しが違います）。「自己テスト」シートの名前を変えてから実行してください。');
      return { status: 'foreignSheet' };
    }
    previousRows = selfTestSheetText_(existing);
  }

  // 2. M01・M02 の書き込み（推奨 6）。請求書は毎回作り直すので、書き込みがあれば何も書かずに止める
  var written = previousRows.filter(function (r) {
    return (r[0] === 'M01' || r[0] === 'M02') && String(r[4] === undefined ? '' : r[4]).replace(/[\s　]/g, '') !== '';
  });
  if (written.length > 0) {
    ui.alert(SELFTEST_MANUAL_STOP_MESSAGE);
    return { status: 'manualWritten' };
  }

  // 3. 回の始めに 1 回だけ読む値（I01〜I03）と、「設定」シートの中身（B06 で前後を比べる）
  var start = tick();
  var nowText = Utilities.formatDate(new Date(start), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var print = fingerprintSources(SELFTEST_FINGERPRINT_FUNCS, SELFTEST_FINGERPRINT_VARS, function (name) { return globalThis[name]; });
  var configSheet = ss.getSheetByName(SELFTEST_CONFIG_SHEET);
  var ctx = {
    ss: ss,
    clock: tick,
    run: 1,
    secrets: [],
    info: selfTestInfoRows_(nowText, SELFTEST_VERSION, String(ss.getName()), print.ok ? codeFingerprint(print.sources) : '取れません'),
    results: {},
    manual: SELFTEST_MANUAL.map(function (m) { return { id: m.id, title: m.title, detail: '' }; }),
    state: { configBefore: configSheet ? selfTestSheetText_(configSheet) : null },
    overall: { result: '未完了', detail: '途中で止まりました。もう一度「自己テスト（開発用）」を押すと最初から実施します' },
    sheet: null,
  };
  SELFTEST_PLAN.forEach(function (p) {
    ctx.results[p.id] = { result: '未実施', detail: SELFTEST_NOT_YET, seconds: '', run: 1 };
  });

  // 4. シートを作り直して、全部「未実施」で書く（6.1 の 1）
  ctx.sheet = selfTestPrepareSheet_(ctx);
  selfTestWrite_(ctx);

  // 5. 項目を順に流す
  SELFTEST_PLAN.forEach(function (p) {
    if (p.by) return;
    if (p.needs && ctx.results[p.needs].result !== '○') {
      selfTestSetWithSubs_(ctx, p, { result: '未実施', detail: SELFTEST_B01_FAILED, seconds: '' });
      selfTestWrite_(ctx);
      return;
    }
    selfTestSetWithSubs_(ctx, p, { result: '実行中', detail: '', seconds: '' });
    selfTestWrite_(ctx);
    selfTestRunItem_(ctx, p);
    selfTestWrite_(ctx);
  });

  // 6. 全体の判定
  var plan = SELFTEST_PLAN.filter(function (p) { return p.kind === '判定'; }).map(function (p) { return p.id; });
  var results = {};
  plan.forEach(function (id) { results[id] = ctx.results[id]; });
  ctx.overall = overallResult(plan, results);
  ctx.overallSeconds = (tick() - start) / 1000;
  selfTestWrite_(ctx);
  ctx.sheet.activate();
  ui.alert(selfTestFinalMessage_(ctx.overall));
  return { status: 'done', overall: ctx.overall };
}

/** p の結果と、p の関数の中で確かめる項目（B03）の結果を同じにする（流せなかったとき・実行中） */
function selfTestSetWithSubs_(ctx, p, value) {
  [p].concat(SELFTEST_PLAN.filter(function (q) { return q.by === p.id; })).forEach(function (q) {
    ctx.results[q.id] = { result: value.result, detail: value.detail, seconds: value.seconds, run: ctx.run };
  });
}

/** 1 つの項目を流して結果を入れる。例外は ×。p の関数の中で確かめる項目（B03）も、ここで結果を決める */
function selfTestRunItem_(ctx, p) {
  var c = selfTestItemContext_(ctx);
  var t0 = ctx.clock();
  var error = null;
  try {
    p.run(c);
  } catch (e) {
    error = e;
    console.error(e && e.stack || e);
  }
  var seconds = (ctx.clock() - t0) / 1000;
  var value = error ? { result: '×', detail: '例外: ' + selfTestMessage_(error) } : selfTestFinish_(c);
  ctx.results[p.id] = { result: value.result, detail: value.detail, seconds: seconds, run: ctx.run };
  SELFTEST_PLAN.forEach(function (q) {
    if (q.by !== p.id) return;
    var sub = selfTestHasOwn_(c.subs, q.id) ? c.subs[q.id] : null;
    var v;
    if (error) v = { result: '×', detail: '例外（' + p.id + ' の中）: ' + selfTestMessage_(error) };
    else if (sub && (sub.checks.length > 0 || sub.notRunText)) v = selfTestFinish_(sub);
    else if (value.result === '未実施') v = { result: '未実施', detail: value.detail };
    else v = { result: '未実施', detail: '実施できません: ' + p.id + ' の途中で止まったため' };
    ctx.results[q.id] = { result: v.result, detail: v.detail, seconds: '', run: ctx.run };
  });
}

/** 項目の関数に渡すもの。expect で確かめるはずの数を決め、check で 1 つずつ確かめる（必須 1）。sub は B03 のような別の項目 */
function selfTestItemContext_(ctx) {
  var c = {
    ss: ctx.ss,
    run: ctx,
    state: ctx.state,
    expected: 0,
    checks: [],
    notes: [],
    notRunText: null,
    subs: {},
  };
  c.expect = function (n) { c.expected += n; };
  c.check = function (name, ok, detail) { c.checks.push({ name: name, ok: !!ok, detail: detail }); };
  // 確かめられなかった n 個の条件を、まとめて × として数える（ID を取れないなど）
  c.fail = function (name, n, detail) { c.checks.push({ name: name, ok: false, count: n, detail: detail }); };
  c.checkTable = function (name, cmp, diffs) {
    c.checks.push({ name: name, count: cmp.compared, ok: cmp.diffs.length === 0 && cmp.compared === cmp.expectedCount, diffs: diffs || cmp.diffs });
  };
  c.note = function (text) { c.notes.push(text); };
  c.notRun = function (text) { c.notRunText = text; };
  c.sub = function (id) {
    if (!selfTestHasOwn_(c.subs, id)) c.subs[id] = selfTestItemContext_(ctx);
    return c.subs[id];
  };
  return c;
}

function selfTestFinish_(c) {
  // 違いが 1 つでもあれば、途中で実施できなくなっても ×（5 章の冒頭。未実施で × を隠さない。仕様 4.5 版 4）
  if (c.notRunText && c.checks.some(function (x) { return !x.ok; })) {
    var failed = itemResult(c.expected, c.checks);
    return { result: '×', detail: failed.detail + '。' + c.notRunText };
  }
  if (c.notRunText) return { result: '未実施', detail: c.notRunText };
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

/** シートを作り直す（請求書は毎回）。書く範囲を全部 @ にしてから色と幅を付ける（推奨 6） */
function selfTestPrepareSheet_(ctx) {
  var ss = ctx.ss;
  var old = ss.getSheetByName(SELFTEST_SHEET);
  if (old) ss.deleteSheet(old);
  var sheet = ss.insertSheet(SELFTEST_SHEET, 0);
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

function selfTestSheetText_(sheet) {
  return sheet.getDataRange().getValues().map(function (r) { return r.map(function (v) { return v === null || v === undefined ? '' : String(v); }); });
}

// ---- 請求書の準備と実行 ----

/** シートを消して、見出しと rows で作り直す */
function selfTestRebuildSheet_(ss, name, rows) {
  var old = ss.getSheetByName(name);
  if (old) ss.deleteSheet(old);
  var sheet = ss.insertSheet(name);
  var all = [SELFTEST_TABLE_HEADERS[name]].concat(rows);
  sheet.getRange(1, 1, all.length, SELFTEST_TABLE_HEADERS[name].length).setValues(all);
  return sheet;
}

/**
 * 項目の始めに「顧客」「請求明細」を sampleData で、「発行履歴」を見出しと history の行で作り直す（推奨 4）。
 * 「顧客」のメールアドレスの列は、どの項目でも空にする。DRY_RUN の項目（B02・B04）でも空にするのは、本番の DRY_RUN の
 * 扱いが壊れて本番モードで流れたときに、下書きまで進まないようにするため（tester 2026-10-19。B02・B04 は宛先を見ない）。
 * 「ログ」はなければ作る（消さない。行を足すだけ）。options: { history }
 */
function selfTestResetSheets_(c, options) {
  var opts = options || {};
  var data = sampleData(SELFTEST_SAMPLE_MONTH);
  var customers = data.customers.map(function (r) {
    var row = r.slice();
    row[4] = '';
    return row;
  });
  selfTestRebuildSheet_(c.ss, '顧客', customers);
  selfTestRebuildSheet_(c.ss, '請求明細', data.items);
  selfTestRebuildSheet_(c.ss, '発行履歴', opts.history || []);
  if (!c.ss.getSheetByName('ログ')) {
    var log = c.ss.insertSheet('ログ');
    log.getRange(1, 1, 1, 3).setValues([SELFTEST_TABLE_HEADERS['ログ']]);
  }
  return data;
}

/** 初期値（DEFAULT_CONFIG）から作った設定。DRY_RUN が TRUE でなければ c.notRun して null（6.2） */
function selfTestDryRunConfig_(c) {
  var config = parseConfigRows(DEFAULT_CONFIG);
  if (config.DRY_RUN !== true) {
    c.notRun(SELFTEST_B01_FAILED);
    return null;
  }
  return config;
}

function selfTestRunInvoices_(config) {
  var d = SELFTEST_ISSUE_DATE;
  return runInvoicesWith_(SELFTEST_YEAR_MONTH, new Date(d[0], d[1], d[2]), config);
}

function selfTestLogCount_(ss) {
  var sheet = ss.getSheetByName('ログ');
  return sheet ? sheet.getLastRow() : 0;
}

/** 「ログ」に足された行（文字） */
function selfTestLogAdded_(ss, before) {
  var sheet = ss.getSheetByName('ログ');
  if (!sheet) return [];
  return selfTestSheetText_(sheet).slice(before).filter(function (r) { return r.some(function (v) { return v !== ''; }); });
}

/** 戻り値の created・skipped と、文の頭（head が null なら見ない） */
function selfTestCheckReturn_(c, result, created, skipped, head, label) {
  var where = label ? label + ': ' : '';
  var message = String(result && result.message || '');
  var shortMessage = message.slice(0, 120);
  c.check('created', result && result.created === created, where + 'created が ' + (result && result.created) + '（期待 ' + created + '）: ' + shortMessage);
  c.check('skipped', result && result.skipped === skipped, where + 'skipped が ' + (result && result.skipped) + '（期待 ' + skipped + '）: ' + shortMessage);
  if (head !== null) c.check('文の頭', message.indexOf(head) === 0, where + '文が「' + head + '」で始まりません: ' + shortMessage);
}

/** 文に line とちょうど同じ行があるか。なければ、同じ頭（最後の空白より前）の行を実際として書く */
function selfTestCheckLine_(c, result, line) {
  var lines = String(result && result.message || '').split('\n');
  var cut = line.lastIndexOf(' ');
  var head = cut > 0 ? line.slice(0, cut) : line;
  var similar = lines.filter(function (l) { return l.indexOf(head) === 0; });
  c.check('文の行', lines.indexOf(line) !== -1, '文に「' + line + '」の行がありません（実際: ' + (similar.length > 0 ? similar.join('、') : 'その行なし') + '）');
}

/** B03: ログの 1 行から PDF を開き、MIME・大きさ・名前を確かめる（3 つ） */
function selfTestCheckPdf_(b, row, name) {
  if (!row) {
    b.fail(name, 3, name + ': ログに確認用 PDF の行がありません');
    return;
  }
  var url = row[2].slice(SELFTEST_LOG_PREVIEW.length);
  var id = selfTestPdfId_(url);
  if (!id) {
    b.fail(name, 3, name + ': ログの URL から ID を取れません（URL の形: ' + selfTestUrlShape_(url) + '）');
    return;
  }
  b.run.secrets.push(id);
  var file;
  try {
    file = DriveApp.getFileById(id);
  } catch (e) {
    b.fail(name, 3, name + ': ファイルを開けません: ' + selfTestMessage_(e));
    return;
  }
  var mime;
  var size;
  var actualName;
  try {
    mime = String(file.getMimeType());
    size = file.getSize();
    actualName = String(file.getName());
  } catch (e) {
    // B03 だけを × にする（B02 の確認を例外で消さない）
    b.fail(name, 3, name + ': ファイルを読めません: ' + selfTestMessage_(e));
    return;
  }
  b.check('MIME', mime === SELFTEST_PDF_MIME, name + ': MIME が「' + mime + '」');
  b.check('大きさ', typeof size === 'number' && size > 0, name + ': 大きさが ' + size);
  b.check('名前', actualName === name, '名前: 期待「' + name + '」実際「' + actualName + '」');
}

/** 自己テストの PDF の置き場所。ゴミ箱に入っていない「自己テスト_請求書」を使い、なければ作る */
function selfTestFolder_() {
  var it = DriveApp.getFoldersByName(SELFTEST_FOLDER_NAME);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return DriveApp.createFolder(SELFTEST_FOLDER_NAME);
}

/** ファイル（ID）の親に folderId があるか */
function selfTestInFolder_(fileId, folderId) {
  var parents = DriveApp.getFileById(fileId).getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return true;
  }
  return false;
}

// ---- 項目（5.2） ----

function selfTestB01_(c) {
  c.expect(1);
  var config = parseConfigRows(DEFAULT_CONFIG);
  c.check('DRY_RUN', config.DRY_RUN === true, '初期値の DRY_RUN が「' + String(config.DRY_RUN) + '」（期待 TRUE）');
}

/** B02 と B03（B03 は B02 のログを読む。6.6） */
function selfTestB02_(c) {
  c.expect(3 + 2 + 1 + 1 + 1);
  var b03 = c.sub('B03');
  b03.expect(3 * 2);
  var config = selfTestDryRunConfig_(c);
  if (!config) {
    b03.notRun(SELFTEST_B01_FAILED);
    return;
  }
  selfTestResetSheets_(c, {});
  var logBefore = selfTestLogCount_(c.ss);
  var result = selfTestRunInvoices_(config);

  selfTestCheckReturn_(c, result, 2, 0, SELFTEST_HEAD_DRY_RUN);
  selfTestCheckLine_(c, result, SELFTEST_LINE_C001);
  selfTestCheckLine_(c, result, SELFTEST_LINE_C002);
  var history = selfTestSheetText_(c.ss.getSheetByName('発行履歴'));
  var historyOk = history.length === 1 && history[0].join('\t') === SELFTEST_TABLE_HEADERS['発行履歴'].join('\t');
  c.check('発行履歴', historyOk, '発行履歴が見出しだけではありません（' + history.length + ' 行）');
  var added = selfTestLogAdded_(c.ss, logBefore);
  var previews = added.filter(function (r) { return r[1] === 'INFO' && r[2].indexOf(SELFTEST_LOG_PREVIEW) === 0; });
  c.check('ログの確認用 PDF', added.length === 2 && previews.length === 2,
    'ログに足された行が ' + added.length + ' 行で、うち INFO の「' + SELFTEST_LOG_PREVIEW + '」が ' + previews.length + ' 行（期待 2 行と 2 行）');
  var errors = added.filter(function (r) { return r[1] === 'ERROR'; });
  c.check('ログの ERROR', errors.length === 0, 'ログに ERROR があります: ' + (errors.length > 0 ? errors[0][2].split('\n')[0].slice(0, 100) : ''));

  SELFTEST_INVOICES.forEach(function (inv, i) { selfTestCheckPdf_(b03, previews[i], inv.previewName); });
}

function selfTestB04_(c) {
  c.expect(3 + 2);
  var config = selfTestDryRunConfig_(c);
  if (!config) return;
  var first = SELFTEST_INVOICES[0];
  selfTestResetSheets_(c, { history: [["'" + SELFTEST_SAMPLE_MONTH, first.customerId, first.number, first.total, '', '作成済み', new Date()]] });
  var result = selfTestRunInvoices_(config);
  selfTestCheckReturn_(c, result, 1, 1, SELFTEST_HEAD_DRY_RUN);
  selfTestCheckLine_(c, result, SELFTEST_LINE_SKIPPED);
  selfTestCheckLine_(c, result, SELFTEST_LINE_C002);
}

/**
 * B05: DRY_RUN = FALSE で 2 回。全員のメールアドレスを空にして、本番が下書きを作らない形で流す（6.2）。
 * 読み直した「顧客」の全セルにメールアドレスになりうる値がないことを、流す前に確かめる（1 つでもあれば流さずに ×）
 */
function selfTestB05_(c) {
  c.expect(2 + 3 + 1 + 2 + 2 + 2 + 2 + 2 + 1);
  if (!selfTestDryRunConfig_(c)) return;
  var data = selfTestResetSheets_(c, {});
  var customers = selfTestSheetText_(c.ss.getSheetByName('顧客'));
  var count = customers.length - 1;
  c.check('顧客の行の数', count === data.customers.length && count > 0, '読み直した「顧客」のデータの行が ' + count + ' 行（期待 ' + data.customers.length + ' 行）');
  var emails = selfTestEmailCells_(customers, isValidEmail);
  c.check('メールアドレスがない', emails.length === 0, '読み直した「顧客」にメールアドレスになりうる値が残っています: ' + emails.slice(0, 3).join('・') + '（下書きを作らないように、流していません）');
  if (emails.length > 0 || count <= 0) return;

  // 設定はこの項目の中だけで新しく作る（ほかの項目と共有しない。任意 7）
  var config = parseConfigRows(DEFAULT_CONFIG);
  config.DRY_RUN = false;
  var folder = selfTestFolder_();
  var folderId = String(folder.getId() || '');
  if (!folderId) {
    // FOLDER_ID が空だと、本番は「請求書」フォルダを作って「設定」に書き戻す（main.js の getFolder_）。流さずに ×
    c.fail('フォルダ', 15, '「' + SELFTEST_FOLDER_NAME + '」フォルダの ID を取れないので、流していません');
    return;
  }
  c.run.secrets.push(folderId);
  config.FOLDER_ID = folderId;

  var first = selfTestRunInvoices_(config);
  selfTestCheckReturn_(c, first, 2, 0, SELFTEST_HEAD_ISSUED, '1 回目');
  var history = selfTestSheetText_(c.ss.getSheetByName('発行履歴')).slice(1);
  c.check('発行履歴の行の数', history.length === 2, '1 回目: 発行履歴が ' + history.length + ' 行（期待 2 行）');
  SELFTEST_INVOICES.forEach(function (inv, i) {
    var row = history[i];
    var where = '発行履歴の ' + (i + 2) + ' 行目';
    c.check('請求金額', !!row && row[3] === String(inv.total), where + 'の請求金額: 期待「' + inv.total + '」実際「' + (row ? row[3] : 'なし') + '」');
  });
  SELFTEST_INVOICES.forEach(function (inv, i) {
    var row = history[i];
    c.check('Gmail下書き', !!row && row[5] === SELFTEST_DRAFT_NONE, '発行履歴の ' + (i + 2) + ' 行目の Gmail下書き: 期待「' + SELFTEST_DRAFT_NONE + '」実際「' + (row ? row[5] : 'なし') + '」');
  });
  SELFTEST_INVOICES.forEach(function (inv, i) {
    var row = history[i];
    c.check('請求書番号', !!row && row[2] === inv.number, '発行履歴の ' + (i + 2) + ' 行目の請求書番号: 期待「' + inv.number + '」実際「' + (row ? row[2] : 'なし') + '」');
  });
  SELFTEST_INVOICES.forEach(function (inv, i) {
    var row = history[i];
    var id = row ? selfTestPdfId_(row[4]) : '';
    if (id) c.run.secrets.push(id);
    var inside = false;
    var why = row ? 'PDF の URL から ID を取れません（URL の形: ' + selfTestUrlShape_(row ? row[4] : '') + '）' : '行がありません';
    if (id) {
      try {
        inside = selfTestInFolder_(id, folderId);
        why = '親のフォルダが「' + SELFTEST_FOLDER_NAME + '」ではありません';
      } catch (e) {
        why = 'PDF を開けません: ' + selfTestMessage_(e);
      }
    }
    c.check('PDF の置き場所', inside, '発行履歴の ' + (i + 2) + ' 行目: ' + why);
  });

  var second = selfTestRunInvoices_(config);
  selfTestCheckReturn_(c, second, 0, 2, null, '2 回目');
  var after = selfTestSheetText_(c.ss.getSheetByName('発行履歴')).slice(1);
  c.check('2 回目の発行履歴', after.length === 2, '2 回目: 発行履歴が ' + after.length + ' 行（期待 2 行のまま）');
}

/** B06: 自己テストの前後で「設定」シートが同じ。なければ、ないままか（推奨 8）。値は詳細に書かない（ID が入りうるため） */
function selfTestB06_(c) {
  var before = c.state.configBefore;
  var sheet = c.ss.getSheetByName(SELFTEST_CONFIG_SHEET);
  if (before === null) {
    c.expect(1);
    c.check('「設定」なし', !sheet, '「設定」がなかったのに、自己テストのあとにあります');
    c.note('「設定」なし。ないままかだけを確認');
    return;
  }
  var cells = 0;
  before.forEach(function (r) { cells += r.length; });
  c.expect(cells);
  if (!sheet) {
    c.fail('「設定」', cells, '「設定」シートが消えました');
    return;
  }
  var cmp = compareTables(before, selfTestSheetText_(sheet), { name: '設定' });
  c.checkTable('設定', cmp, cmp.diffs.map(function (d) { return { text: d.cell + ' が変わりました' }; }));
}

if (typeof module !== 'undefined') {
  module.exports = {
    SELFTEST_VERSION: SELFTEST_VERSION,
    SELFTEST_HEADERS: SELFTEST_HEADERS,
    SELFTEST_M03_TEXT: SELFTEST_M03_TEXT,
    SELFTEST_PLAN: SELFTEST_PLAN,
    SELFTEST_MANUAL: SELFTEST_MANUAL,
    SELFTEST_INVOICES: SELFTEST_INVOICES,
    SELFTEST_FINGERPRINT_FUNCS: SELFTEST_FINGERPRINT_FUNCS,
    SELFTEST_FINGERPRINT_VARS: SELFTEST_FINGERPRINT_VARS,
    columnLetter: columnLetter,
    compareTables: compareTables,
    formatDiffs: formatDiffs,
    itemResult: itemResult,
    overallResult: overallResult,
    buildSelfTestValues: buildSelfTestValues,
    codeFingerprint: codeFingerprint,
    fingerprintSources: fingerprintSources,
    selfTestInfoRows_: selfTestInfoRows_,
    selfTestSafeText_: selfTestSafeText_,
    selfTestFinalMessage_: selfTestFinalMessage_,
    selfTestPdfId_: selfTestPdfId_,
    selfTestUrlShape_: selfTestUrlShape_,
    selfTestEmailCells_: selfTestEmailCells_,
  };
}
