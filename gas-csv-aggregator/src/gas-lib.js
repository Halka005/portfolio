/**
 * GAS 版だけで使う純粋関数（Google のサービスは使わない）。
 * lib.js は excel-csv-aggregator/src/lib.js のコピーで変えられないので、GAS 版で足す関数はここに置く（仕様 3.4）。
 * lib.js の関数（TrimText・CleanFolderPath など）は、呼び出したときにグローバルから使う。
 * 最上位では他のファイルの名前を使わない（GAS で読み込む順番に依存しないため）。
 */

var SHEET_SETTINGS = '設定';
var ENCODING_AUTO = '自動';
var OVERALL_FILE_NAME = '（全体）';
var GOOGLE_MIME_PREFIX = 'application/vnd.google-apps.';
var GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
var GOOGLE_SHEET_NOTE = 'CSV が Google スプレッドシートに変わっている可能性があります';
var GOOGLE_FORMAT_NOTE = 'Google 形式のファイル';
var GOOGLE_FORMAT_MESSAGE = 'Google スプレッドシートなどの Google 形式のファイルは読めません。CSV ファイルのままフォルダに置いてください';
var SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
var SHORTCUT_MESSAGE = 'ショートカットは読めません。元の CSV をこのフォルダにコピーしてください';
var DECODE_FAILURE_MESSAGE = '文字コードの変換で読めない文字がありました。ENCODING の設定と、ファイルの文字コードを確かめてください';
var SKIPPED_MESSAGE_LIMIT = 10;
var SETTINGS_MESSAGE_HEAD = '「設定」シートを確認してください（キーがない場合は ① 設定シートを作る を実行）。';

// [キー, 初期値, 説明]。並びと初期値は VBA 版と同じ（仕様 4.1）
var DEFAULT_SETTINGS = [
  ['CSV_FOLDER', '', 'CSV を入れた Google ドライブのフォルダの URL（ブラウザのアドレス欄をそのまま貼る）か、フォルダの ID'],
  ['ENCODING', '自動', 'CSV の文字コード。自動 / UTF-8 / Shift_JIS。文字化けしたときだけ変える'],
  ['COL_DATE', '注文日', '日付の列の見出し名（必須）'],
  ['COL_PRODUCT', '商品名', '商品の列の見出し名（必須）'],
  ['COL_QUANTITY', '数量', '数量の列の見出し名（必須）'],
  ['COL_AMOUNT', '金額', '金額の列の見出し名（必須）'],
  ['COL_ORDER_ID', '注文番号', '注文番号の列の見出し名（任意）。空なら使わない。空にした場合、別のファイルにある同じ内容の行は 1 行にまとめます。1 日分を複数のファイルに分けているなら DEDUPE を FALSE に'],
  ['DEDUPE', 'TRUE', 'TRUE なら、複数の CSV にある同じ行を 1 回だけ数える'],
  ['QUOTE_CHECK', 'TRUE', 'TRUE なら、引用符（"）で囲んだ複数行の値の中に 1 行分以上のデータに見える数のカンマがあるとき、行が消えている可能性としてエラーにする。備考などに本当にカンマの多い複数行の文があってエラーになる場合だけ FALSE にし、その回の集計が終わったら TRUE に戻す'],
];

// 出力の 5 シート。「設定」は入れない（書かない・消さない）
var OUTPUT_SHEETS = ['集計', '月別合計', '明細', '取り込み結果', 'エラー'];
var OUTPUT_HEADERS = {
  '集計': ['年月', '商品', '数量', '金額'],
  '月別合計': ['年月', '数量', '金額'],
  '明細': ['年月', '日付', '注文番号', '商品', '数量', '金額', '元ファイル', '元の行'],
  '取り込み結果': ['ファイル', '文字コード', 'データ行', '使った行', '重複で除いた行'],
  'エラー': ['ファイル', '行', '内容'],
};
// 列の番号は 1 から。textCols は書く前に書式を @ にする列、numberCols は #,##0 などにする列
var OUTPUT_LAYOUT = {
  '集計': { textCols: [1, 2], numberCols: [3, 4] },
  '月別合計': { textCols: [1], numberCols: [2, 3] },
  '明細': { textCols: [1, 2, 3, 4, 7], numberCols: [5, 6] },
  '取り込み結果': { textCols: [1, 2], numberCols: [3, 4, 5] },
  'エラー': { textCols: [1, 3], integerCols: [2] },
};

/** 文字コード順（UTF-16 のコード単位）で比べる */
function compareCodeUnits_(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasOwn_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * CSV_FOLDER（URL か ID）から Google ドライブのフォルダの ID を取り出す。取れなければ ''。
 * 1. /folders/ の後ろ 2. ?id= か &id= の後ろ 3. 全体が 10 文字以上の英数字・_・-
 */
function extractFolderId(s) {
  var t = CleanFolderPath(s === undefined || s === null ? '' : String(s));
  var m = t.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = t.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(t)) return t;
  return '';
}

/** シートのセルの値を設定の文字にする（真偽値は TRUE / FALSE。Sheets は TRUE と打つと真偽値に変えることがあるため） */
function settingText_(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  if (v === null || v === undefined) return '';
  return TrimText(String(v));
}

/**
 * 「設定」シートの 2 行目以降（getValues() の A・B 列）を読む。同じキーが 2 行あれば上の行を使う。
 * 戻り値: DEFAULT_SETTINGS のキーをすべて持つオブジェクト（キーの行がなければ ''。QUOTE_CHECK は空なら 'TRUE'）
 */
function readSettings(rows) {
  var result = {};
  (rows || []).forEach(function (row) {
    var key = settingText_(row[0]);
    if (key !== '' && !hasOwn_(result, key)) result[key] = settingText_(row[1]);
  });
  var settings = {};
  DEFAULT_SETTINGS.forEach(function (d) { settings[d[0]] = hasOwn_(result, d[0]) ? result[d[0]] : ''; });
  settings.DEDUPE = settings.DEDUPE.toUpperCase();
  settings.QUOTE_CHECK = settings.QUOTE_CHECK.toUpperCase();
  if (settings.QUOTE_CHECK === '') settings.QUOTE_CHECK = 'TRUE';
  return settings;
}

/** 設定の検査。問題がなければ ''、あれば先頭の文と「・」で始まる行をまとめた文 */
function validateSettings(settings) {
  var lines = [];
  if (settings.CSV_FOLDER === '') {
    lines.push('・CSV_FOLDER が空です。CSV を入れた Google ドライブのフォルダの URL を貼ってください');
  } else if (extractFolderId(settings.CSV_FOLDER) === '') {
    lines.push('・CSV_FOLDER から Google ドライブのフォルダの ID を読み取れません: ' + settings.CSV_FOLDER);
  }
  ['COL_DATE', 'COL_PRODUCT', 'COL_QUANTITY', 'COL_AMOUNT'].forEach(function (key) {
    if (settings[key] === '') lines.push('・' + key + ' が空です');
  });
  if (settings.ENCODING !== ENCODING_AUTO && settings.ENCODING !== ENCODING_UTF8 && settings.ENCODING !== ENCODING_SJIS) {
    lines.push('・ENCODING は「' + ENCODING_AUTO + '」「' + ENCODING_UTF8 + '」「' + ENCODING_SJIS + '」のどれかにしてください');
  }
  if (settings.DEDUPE !== 'TRUE' && settings.DEDUPE !== 'FALSE') lines.push('・DEDUPE は TRUE か FALSE にしてください');
  if (settings.QUOTE_CHECK !== 'TRUE' && settings.QUOTE_CHECK !== 'FALSE') lines.push('・QUOTE_CHECK は TRUE か FALSE にしてください');
  return lines.length > 0 ? SETTINGS_MESSAGE_HEAD + '\n' + lines.join('\n') : '';
}

/** lib.js の AggregateFiles に渡す設定にする */
function toAggregateSettings(settings) {
  return {
    encoding: settings.ENCODING,
    dedupe: settings.DEDUPE === 'TRUE',
    quoteCheck: settings.QUOTE_CHECK === 'TRUE',
    colNames: {
      date: settings.COL_DATE,
      product: settings.COL_PRODUCT,
      quantity: settings.COL_QUANTITY,
      amount: settings.COL_AMOUNT,
      orderId: settings.COL_ORDER_ID,
    },
  };
}

/** 同じ名前が 2 つ以上ある名前。戻り値: [{ name, count }]（最初に出た順） */
function findDuplicateNames(names) {
  var counts = {};
  var order = [];
  names.forEach(function (name) {
    if (!hasOwn_(counts, name)) { counts[name] = 0; order.push(name); }
    counts[name]++;
  });
  return order.filter(function (name) { return counts[name] > 1; })
    .map(function (name) { return { name: name, count: counts[name] }; });
}

/**
 * 読まなかったファイルとサブフォルダ（仕様 4.2。黙って読み飛ばさないため）。
 * entries: ゴミ箱を除いた [{ name, id, mimeType }]、selectedNames: ListCsvFiles で選んだ名前、
 * selfId: このスプレッドシートの ID（除く）、folderNames: サブフォルダの名前
 * 戻り値: { files: [{ name, note }]（名前の文字コード順）, folders: [名前]（文字コード順） }
 */
function listSkippedItems(entries, selectedNames, selfId, folderNames) {
  var selected = {};
  selectedNames.forEach(function (name) { selected[name] = true; });
  var files = entries
    .filter(function (e) { return !hasOwn_(selected, e.name) && e.id !== selfId; })
    .map(function (e) {
      var mime = String(e.mimeType || '');
      var note = mime === GOOGLE_SHEET_MIME ? GOOGLE_SHEET_NOTE : mime.indexOf(GOOGLE_MIME_PREFIX) === 0 ? GOOGLE_FORMAT_NOTE : '';
      return { name: e.name, note: note };
    })
    .sort(function (a, b) { return compareCodeUnits_(a.name, b.name); });
  return { files: files, folders: (folderNames || []).slice().sort(compareCodeUnits_) };
}

function joinNamesForMessage_(names) {
  var shown = names.slice(0, SKIPPED_MESSAGE_LIMIT).join('、');
  return names.length > SKIPPED_MESSAGE_LIMIT ? shown + '、ほか ' + (names.length - SKIPPED_MESSAGE_LIMIT) + ' 件' : shown;
}

/** 読まなかったものをメッセージ用の文にする。何もなければ ''。名前は 10 個まで並べ、残りは「ほか {n} 件」 */
function formatSkippedForMessage(skipped) {
  var lines = [];
  var fileNames = skipped.files.map(function (f) { return f.name; });
  if (fileNames.length > 0) lines.push('読まなかったファイル: ' + fileNames.length + ' 件（' + joinNamesForMessage_(fileNames) + '）');
  if (skipped.folders.length > 0) lines.push('サブフォルダは読みません: ' + skipped.folders.length + ' 件（' + joinNamesForMessage_(skipped.folders) + '）');
  var sheets = skipped.files.filter(function (f) { return f.note === GOOGLE_SHEET_NOTE; }).map(function (f) { return f.name; });
  if (sheets.length > 0) lines.push(GOOGLE_SHEET_NOTE + ': ' + joinNamesForMessage_(sheets));
  return lines.join('\n');
}

/**
 * 最初の U+FFFD（変換できなかったバイトを置き換えた文字）がある行（1 から）。なければ 0。
 * CRLF・CR・LF をどれも 1 つの改行として数える。引用符の中の改行も数える（テキストエディタで開いたときの行番号）
 */
function findReplacementCharLine(text) {
  var line = 1;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c === 0xfffd) return line;
    if (c === 13) {
      line++;
      if (text.charCodeAt(i + 1) === 10) i++;
    } else if (c === 10) {
      line++;
    }
  }
  return 0;
}

/**
 * 読めなかったファイル（Google 形式・例外。行 0）と、変換で U+FFFD が出たファイルの失敗（failures）を、
 * AggregateFiles の結果にまとめる。並びは VBA 版と同じ: ファイル名の順に、失敗したファイルはその 1 件だけ、
 * それ以外は lib.js のエラー（元の順）。最後に（全体）のエラー。
 * 件数が合わなければ例外を投げる（黙ってファイル抜きの集計を出さないため。仕様 4.2）。
 * 戻り値: エラーがあれば { errors, reports }、なければ result と同じ形（reports は names の順）
 */
function mergeReadFailures(names, result, failures) {
  var nameSet = {};
  names.forEach(function (name) { nameSet[name] = true; });
  var failureByFile = {};
  failures.forEach(function (f) {
    if (!hasOwn_(nameSet, f.file)) throw new Error('mergeReadFailures: 読む一覧にないファイルの失敗です: ' + f.file);
    if (hasOwn_(failureByFile, f.file)) throw new Error('mergeReadFailures: 同じファイルの失敗が 2 つあります: ' + f.file);
    failureByFile[f.file] = f;
  });
  var errorsByFile = {};
  var overall = [];
  var keptLibErrors = 0;
  result.errors.forEach(function (e) {
    if (e.file === OVERALL_FILE_NAME) { overall.push(e); keptLibErrors++; return; }
    if (!hasOwn_(nameSet, e.file)) throw new Error('mergeReadFailures: 読む一覧にないファイルのエラーです: ' + e.file);
    if (hasOwn_(failureByFile, e.file)) return; // 化けた文字などから出たエラーなので捨てる
    (errorsByFile[e.file] = errorsByFile[e.file] || []).push(e);
    keptLibErrors++;
  });
  var reportByFile = {};
  result.reports.forEach(function (r) { reportByFile[r.file] = r; });

  var errors = [];
  var reports = [];
  names.forEach(function (name) {
    if (hasOwn_(failureByFile, name)) {
      var f = failureByFile[name];
      errors.push({ file: f.file, line: f.line, message: f.message });
      reports.push({ file: name, encoding: '-', dataRows: 0, usedRows: 0, removed: 0 });
      return;
    }
    (errorsByFile[name] || []).forEach(function (e) { errors.push(e); });
    if (hasOwn_(reportByFile, name)) reports.push(reportByFile[name]);
  });
  overall.forEach(function (e) { errors.push(e); });

  if (errors.length !== failures.length + keptLibErrors) {
    throw new Error('mergeReadFailures: エラーの数が合いません（' + errors.length + ' 件。期待は ' + (failures.length + keptLibErrors) + ' 件）');
  }
  if (reports.length !== names.length) {
    throw new Error('mergeReadFailures: 取り込み結果の数が合いません（' + reports.length + ' 件。CSV は ' + names.length + ' 件）');
  }
  if (errors.length > 0) return { errors: errors, reports: reports };
  var merged = {};
  Object.keys(result).forEach(function (key) { merged[key] = result[key]; });
  merged.errors = [];
  merged.reports = reports;
  return merged;
}

/** Google 形式のファイル（読まない）のエラーの文。ショートカットだけは直し方が違うので別の文にする */
function googleFormatMessage(mimeType) {
  return mimeType === SHORTCUT_MIME ? SHORTCUT_MESSAGE : GOOGLE_FORMAT_MESSAGE;
}

/** このツールが作った出力のシートか（1 行目の見出しが一致。前後の空白は無視、列の数も一致）。空のシートは違うとする */
function isOwnOutputSheet(name, headerRow) {
  var expected = hasOwn_(OUTPUT_HEADERS, name) ? OUTPUT_HEADERS[name] : null;
  if (!expected || !headerRow || headerRow.length !== expected.length) return false;
  for (var i = 0; i < expected.length; i++) {
    if (TrimText(headerRow[i] === null || headerRow[i] === undefined ? '' : String(headerRow[i])) !== expected[i]) return false;
  }
  return true;
}

/**
 * 他人のシートとして止まるときの文。1 行目の先頭がこのツールの見出しと同じで、右に列が多いだけなら
 * （依頼者が表の右にメモを書いた場合）、そう分かる文にする。それ以外は「見出しが違う」の文
 */
function foreignSheetMessage(name, headerRow) {
  var expected = hasOwn_(OUTPUT_HEADERS, name) ? OUTPUT_HEADERS[name] : [];
  var row = headerRow || [];
  if (expected.length > 0 && row.length > expected.length && isOwnOutputSheet(name, row.slice(0, expected.length))) {
    return '「' + name + '」シートの、表より右の列（' + String.fromCharCode(65 + expected.length) + ' 列から右）に、このツールが使わないセルがあります。' +
      'そこに書いたものを別のシートに移してから、もう一度実行してください。';
  }
  return '「' + name + '」シートは、このツールが作ったものではないようです（1 行目の見出しが違います）。シートの名前を変えてから、もう一度実行してください。';
}

/** 文字の列に書く値。guard が真で、= + - @ のどれかで始まる文字なら先頭に ' を付ける（数式として動かさないため） */
function toSheetText(value, guard) {
  if (typeof value !== 'string') return value;
  return guard && /^[=+\-@]/.test(value) ? "'" + value : value;
}

/** 数の列の書式。小数が 1 つでもあれば #,##0.00、なければ #,##0 */
function numberFormatFor(values) {
  for (var i = 0; i < values.length; i++) {
    if (typeof values[i] === 'number' && Math.floor(values[i]) !== values[i]) return '#,##0.00';
  }
  return '#,##0';
}

function headerRow_(name) {
  return OUTPUT_HEADERS[name].slice();
}

/** 「集計」の値（見出しを含む） */
function buildSummaryValues(summary, guard) {
  return [headerRow_('集計')].concat(summary.map(function (x) {
    return [toSheetText(x.ym, guard), toSheetText(x.product, guard), x.quantity, x.amount];
  }));
}

/** 「月別合計」の値（見出しと、最後の「合計」行を含む） */
function buildMonthlyValues(monthly, guard) {
  var qty = 0;
  var amount = 0;
  var rows = monthly.map(function (x) {
    qty += x.quantity;
    amount += x.amount;
    return [toSheetText(x.ym, guard), x.quantity, x.amount];
  });
  return [headerRow_('月別合計')].concat(rows, [['合計', qty, amount]]);
}

/** 「明細」の値（見出しを含む） */
function buildDetailValues(details, guard) {
  return [headerRow_('明細')].concat(details.map(function (x) {
    return [toSheetText(x.ym, guard), toSheetText(x.ymd, guard), toSheetText(x.orderId, guard), toSheetText(x.product, guard),
      x.quantity, x.amount, toSheetText(x.file, guard), x.line];
  }));
}

/**
 * 「取り込み結果」の値。表の下に 1 行空けて、実行日時・フォルダ・読まなかったファイル・サブフォルダを足す（0 件でも行を出す）。
 * meta: { runAt, folderLabel, skipped }。表の下は 1 列目が項目名、2 列目が値・名前、3 列目が note。幅は表と同じ 5 列にそろえる
 */
function buildReportValues(reports, meta, guard) {
  var t = function (v) { return toSheetText(v, guard); };
  var pad = function (row) { while (row.length < 5) row.push(''); return row; };
  var rows = [headerRow_('取り込み結果')].concat(reports.map(function (x) {
    return [t(x.file), t(x.encoding), x.dataRows, x.usedRows, x.removed];
  }));
  rows.push(pad([]));
  rows.push(pad(['実行日時', t(meta.runAt)]));
  rows.push(pad(['フォルダ', t(meta.folderLabel)]));
  rows.push(pad(['読まなかったファイル', meta.skipped.files.length + ' 件']));
  meta.skipped.files.forEach(function (f) { rows.push(pad(['', t(f.name), t(f.note)])); });
  rows.push(pad(['サブフォルダ（読みません）', meta.skipped.folders.length + ' 件']));
  meta.skipped.folders.forEach(function (name) { rows.push(pad(['', t(name), ''])); });
  return rows;
}

/**
 * 「エラー」の値（見出しを含む）。表の下に 1 行空けて実行日時を足す（前回のエラーと見分けるため）。幅は表と同じ 3 列
 */
function buildErrorValues(errors, runAt, guard) {
  return [headerRow_('エラー')].concat(errors.map(function (e) {
    return [toSheetText(e.file, guard), e.line, toSheetText(e.message, guard)];
  }), [['', '', ''], ['実行日時', toSheetText(runAt, guard), '']]);
}

/** 成功のメッセージ。info: { runAt, csvCount, detailRows, removed, skipped } */
function buildSuccessMessage(info) {
  var msg = '集計しました（' + info.runAt + '）。CSV ' + info.csvCount + ' 件、明細 ' + info.detailRows + ' 行（重複で除いた行 ' + info.removed + '）。' +
    '「集計」「月別合計」「明細」「取り込み結果」シートを作り直しました。';
  var skippedText = formatSkippedForMessage(info.skipped);
  return skippedText === '' ? msg : msg + '\n' + skippedText;
}

if (typeof module !== 'undefined') {
  module.exports = {
    SHEET_SETTINGS: SHEET_SETTINGS,
    ENCODING_AUTO: ENCODING_AUTO,
    OVERALL_FILE_NAME: OVERALL_FILE_NAME,
    GOOGLE_SHEET_MIME: GOOGLE_SHEET_MIME,
    GOOGLE_SHEET_NOTE: GOOGLE_SHEET_NOTE,
    GOOGLE_FORMAT_NOTE: GOOGLE_FORMAT_NOTE,
    GOOGLE_FORMAT_MESSAGE: GOOGLE_FORMAT_MESSAGE,
    SHORTCUT_MIME: SHORTCUT_MIME,
    SHORTCUT_MESSAGE: SHORTCUT_MESSAGE,
    DECODE_FAILURE_MESSAGE: DECODE_FAILURE_MESSAGE,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    OUTPUT_SHEETS: OUTPUT_SHEETS,
    OUTPUT_HEADERS: OUTPUT_HEADERS,
    OUTPUT_LAYOUT: OUTPUT_LAYOUT,
    extractFolderId: extractFolderId,
    readSettings: readSettings,
    validateSettings: validateSettings,
    toAggregateSettings: toAggregateSettings,
    findDuplicateNames: findDuplicateNames,
    listSkippedItems: listSkippedItems,
    formatSkippedForMessage: formatSkippedForMessage,
    findReplacementCharLine: findReplacementCharLine,
    mergeReadFailures: mergeReadFailures,
    googleFormatMessage: googleFormatMessage,
    isOwnOutputSheet: isOwnOutputSheet,
    foreignSheetMessage: foreignSheetMessage,
    toSheetText: toSheetText,
    numberFormatFor: numberFormatFor,
    buildSummaryValues: buildSummaryValues,
    buildMonthlyValues: buildMonthlyValues,
    buildDetailValues: buildDetailValues,
    buildReportValues: buildReportValues,
    buildErrorValues: buildErrorValues,
    buildSuccessMessage: buildSuccessMessage,
  };
}
