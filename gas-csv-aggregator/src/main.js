/**
 * CSV 集計ツール（Google Apps Script 版）
 * Google ドライブのフォルダにある CSV を読み、「年月 × 商品」の集計表を同じスプレッドシートに作る。
 * 集計のルールは lib.js（excel-csv-aggregator の参照実装のコピー）、GAS 版だけの純粋関数は gas-lib.js にある。
 * 元の CSV は読むだけ。書くのはこのスプレッドシートの出力用の 5 シートだけ。
 */

// GAS の getDataAsString に渡す Shift_JIS の文字コード名（仕様 4.2）。
// Java の Shift_JIS の表には ①・㈱ がなく、windows-31j（MS932）にはある。受け付けられなければ 'MS932' を試す（README の動作確認）
var SJIS_CHARSET = 'windows-31j';
// 文字の列で = + - @ で始まる値の先頭に ' を付ける（数式として動かさないため。仕様 4.4）
var FORMULA_GUARD = true;
// 6 分の上限で強制的に止められる前に、自分で止める（仕様 6.1）
var READ_LIMIT_MS = 4 * 60 * 1000;
var WRITE_LIMIT_MS = 4 * 60 * 1000 + 30 * 1000;
var LOCK_WAIT_MS = 10 * 1000;
var WORKING_SUFFIX = '（作成中）';
var COLOR_HEADER = '#e0e0e0';
var COLOR_INPUT = '#fff8c5';
var NOT_CHANGED = 'シートは変えていません。';

function onOpen() {
  var menu = SpreadsheetApp.getUi()
    .createMenu('CSV 集計')
    .addItem('① 設定シートを作る', 'setupSettings')
    .addItem('② 集計する', 'runAggregation');
  // 開発用の自己テスト（selftest.js）を貼ったときだけ出す。納品物には selftest.js を入れないので出ない（docs/specs/selftest.md 3.2）
  if (typeof runSelfTest === 'function') menu.addSeparator().addItem('自己テスト（開発用）', 'runSelfTest');
  menu.addToUi();
}

/** 「設定」シートを作る。既にあるキーの値は上書きしない（何度実行してもよい） */
function setupSettings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_SETTINGS) || ss.insertSheet(SHEET_SETTINGS, 0);
  styleHeader_(sheet.getRange(1, 1, 1, 3).setValues([['キー', '値', '説明']]));

  var lastRow = sheet.getLastRow();
  var keys = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return TrimText(String(r[0])); }) : [];
  DEFAULT_SETTINGS.forEach(function (d) {
    var index = keys.indexOf(d[0]);
    var row;
    if (index === -1) {
      row = sheet.getLastRow() + 1;
      sheet.getRange(row, 2).setNumberFormat('@');
      sheet.getRange(row, 1, 1, 3).setValues([[d[0], d[1], d[2]]]);
      keys.push(d[0]);
    } else {
      row = index + 2;
    }
    var valueCell = sheet.getRange(row, 2).setBackground(COLOR_INPUT);
    if (d[0] === 'ENCODING') valueCell.setDataValidation(dropDown_([ENCODING_AUTO, ENCODING_UTF8, ENCODING_SJIS]));
    if (d[0] === 'DEDUPE' || d[0] === 'QUOTE_CHECK') valueCell.setDataValidation(dropDown_(['TRUE', 'FALSE']));
  });
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 360);
  sheet.setColumnWidth(3, 560);
  sheet.setFrozenRows(1);
  sheet.activate();
  SpreadsheetApp.getUi().alert('「設定」シートを用意しました。黄色のセルに CSV のフォルダの URL などを入れてから、メニューの「② 集計する」を実行してください。');
}

/** メニューから実行: 集計して、結果を画面に出す */
function runAggregation() {
  var result = aggregateFolder();
  SpreadsheetApp.getUi().alert(result.message);
}

/**
 * 本体。「設定」のフォルダの CSV を読み、出力のシートを作り直す。
 * clock: 経過時間を測る関数（ミリ秒）。省略時は Date.now。テストから時間を進めるために渡す。
 * 戻り値: { status: 'success' | 'inputError' | 'stopped' | 'failed' | 'swapFailed', message }
 */
function aggregateFolder(clock) {
  return aggregateWith_(clock, null);
}

/**
 * aggregateFolder の中身。settings: readSettings の戻り値と同じ形。null なら「設定」シートから読む。
 * 自己テスト（selftest.js）は「設定」シートを読まず書かないので、設定を引数で渡す（docs/specs/selftest.md 3.2）。
 */
function aggregateWith_(clock, settings) {
  clock = clock || function () { return Date.now(); };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return stopped_('他の集計が実行中です。終わってからもう一度実行してください。');
  }
  var timing = { read: 0, aggregate: 0, write: 0, files: 0, details: 0 };
  try {
    return aggregateLocked_(clock, timing, settings || null);
  } catch (err) {
    console.error(err && err.stack || err);
    if (err && err.swapFailed) {
      return {
        status: 'swapFailed',
        message: 'シートの入れ替えの途中で止まりました: ' + messageOf_(err.cause) + '。前回の結果のシートは一部が消えている可能性があります。' +
          'もう一度「② 集計する」を実行してください（「' + WORKING_SUFFIX + '」のシートは次の実行で消えます）。元の CSV は変更していません。',
      };
    }
    return { status: 'failed', message: '想定外のエラーで止まりました: ' + messageOf_(err) + '。元の CSV は変更していません。前回の結果のシートは残っています。' };
  } finally {
    console.log('時間 読む=' + timing.read + 'ms 集計する=' + timing.aggregate + 'ms 書く=' + timing.write + 'ms ファイル=' + timing.files + ' 明細=' + timing.details + '行');
    lock.releaseLock();
  }
}

function aggregateLocked_(clock, timing, given) {
  var start = clock();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. 設定（渡されたときは「設定」シートを探さない。検査は必ず通す）
  var settings = given;
  if (!settings) {
    var settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
    if (!settingsSheet) return stopped_('「設定」シートがありません。メニューの「① 設定シートを作る」を実行してください。');
    var lastRow = settingsSheet.getLastRow();
    settings = readSettings(lastRow >= 2 ? settingsSheet.getRange(2, 1, lastRow - 1, 2).getValues() : []);
  }
  var settingsError = validateSettings(settings);
  if (settingsError) return stopped_(settingsError);
  // 同じ名前の他人のシートは、CSV を読む前に止める（読む時間を待たせないため）
  var notOwn = findForeignOutputSheet_(ss);
  if (notOwn) return stopped_(foreignSheetMessage_(notOwn));

  // 2. フォルダとファイルの一覧
  var readStart = clock();
  var folder;
  try {
    folder = DriveApp.getFolderById(extractFolderId(settings.CSV_FOLDER));
    folder.getName();
  } catch (e) {
    return stopped_('フォルダが見つかりません。CSV_FOLDER の URL と、そのフォルダを自分が見られるかを確認してください: ' + settings.CSV_FOLDER);
  }
  var folderLabel = folder.getName() + '（ID: ' + folder.getId() + '）';
  // このスプレッドシート自身がフォルダにあっても、名前に関係なく ID で除く（仕様 4.2）
  var selfId = ss.getId();
  var entries = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (f.isTrashed() || f.getId() === selfId) continue;
    entries.push({ name: f.getName(), id: f.getId(), mimeType: f.getMimeType(), file: f });
  }
  var folderNames = [];
  var folders = folder.getFolders();
  while (folders.hasNext()) {
    var sub = folders.next();
    if (!sub.isTrashed()) folderNames.push(sub.getName());
  }
  var names = ListCsvFiles(entries.map(function (e) { return e.name; }));
  var skipped = listSkippedItems(entries, names, selfId, folderNames);
  var skippedText = formatSkippedForMessage(skipped);
  if (names.length === 0) {
    return stopped_('フォルダに CSV ファイルがありません: ' + folder.getName() + '。' + NOT_CHANGED + (skippedText ? '\n' + skippedText : ''));
  }
  var duplicates = findDuplicateNames(names);
  if (duplicates.length > 0) {
    return stopped_('同じ名前の CSV が 2 つ以上あります。名前を変えるか、片方を別のフォルダに移してください: ' +
      duplicates.map(function (d) { return d.name + '（' + d.count + ' 個）'; }).join('、'));
  }

  // 3. 読む。byBytes と decodeFailures は実行ごとに作る（前の実行の結果を持ち越さないため）
  var byName = {};
  entries.forEach(function (e) { byName[e.name] = e; });
  var byBytes = new Map();
  var decodeFailures = [];
  var failures = [];
  var readable = [];
  for (var i = 0; i < names.length; i++) {
    if (clock() - start > READ_LIMIT_MS) {
      timing.read = clock() - readStart;
      return stopped_('時間内に CSV を読み終えられませんでした（' + names.length + ' 件のうち ' + i + ' 件まで）。' + NOT_CHANGED + 'CSV の数を減らしてから実行してください');
    }
    var entry = byName[names[i]];
    if (String(entry.mimeType || '').indexOf(GOOGLE_MIME_PREFIX) === 0) {
      failures.push({ file: entry.name, line: 0, message: googleFormatMessage(entry.mimeType) });
      continue;
    }
    try {
      var blob = entry.file.getBlob();
      var bytes = new Uint8Array(blob.getBytes());
      byBytes.set(bytes, { name: entry.name, blob: blob });
      readable.push({ name: entry.name, bytes: bytes });
    } catch (e) {
      failures.push({ file: entry.name, line: 0, message: 'ファイルを読めません: ' + messageOf_(e) });
    }
  }
  timing.read = clock() - readStart;
  timing.files = names.length;

  // 4. 集計する
  var aggregateStart = clock();
  var result = AggregateFiles(readable, toAggregateSettings(settings), makeDecoder_(byBytes, decodeFailures));
  var merged = mergeReadFailures(names, result, failures.concat(decodeFailures));
  timing.aggregate = clock() - aggregateStart;

  if (merged.errors.length === 0 && merged.noData) {
    return stopped_('CSV にデータの行がありませんでした（見出しだけでした）。集計は作りませんでした。\nフォルダと CSV の中身を確認してください: ' + folderLabel +
      '\n' + NOT_CHANGED + (skippedText ? '\n' + skippedText : ''));
  }

  // 5. 書く
  if (clock() - start > WRITE_LIMIT_MS) {
    return stopped_('集計はできましたが、シートに書く時間が足りない見込みです。' + NOT_CHANGED + 'CSV の数を減らしてから実行してください');
  }
  notOwn = findForeignOutputSheet_(ss); // 読んでいる間に依頼者がシートを足すこともあるので、もう一度見る
  if (notOwn) return stopped_(foreignSheetMessage_(notOwn));

  var runAt = Utilities.formatDate(new Date(start), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  var writeStart = clock();
  try {
    if (merged.errors.length > 0) {
      notOwn = replaceOutputSheets_(ss, [{
        name: 'エラー', values: buildErrorValues(merged.errors, runAt, FORMULA_GUARD), tableRows: merged.errors.length,
        textBlockFrom: merged.errors.length + 3, textBlockCols: 2,
      }]);
      if (notOwn) return stopped_(foreignSheetMessage_(notOwn));
      return {
        status: 'inputError',
        message: '入力に不備が ' + merged.errors.length + ' 件あったため、集計は作りませんでした。\n「エラー」シートで、ファイル名と行番号を確認してください。' +
          '前回の集計シートは、今回の結果と取り違えないよう消しました。',
      };
    }
    timing.details = merged.details.length;
    var reportValues = buildReportValues(merged.reports, { runAt: runAt, folderLabel: folderLabel, skipped: skipped }, FORMULA_GUARD);
    notOwn = replaceOutputSheets_(ss, [
      { name: '集計', values: buildSummaryValues(merged.summary, FORMULA_GUARD), tableRows: merged.summary.length },
      { name: '月別合計', values: buildMonthlyValues(merged.monthly, FORMULA_GUARD), tableRows: merged.monthly.length + 1, boldLastRow: true },
      { name: '明細', values: buildDetailValues(merged.details, FORMULA_GUARD), tableRows: merged.details.length },
      { name: '取り込み結果', values: reportValues, tableRows: merged.reports.length, textBlockFrom: merged.reports.length + 3, textBlockCols: 3 },
    ]);
    if (notOwn) return stopped_(foreignSheetMessage_(notOwn));
  } finally {
    timing.write = clock() - writeStart;
  }
  var removed = merged.reports.reduce(function (sum, r) { return sum + r.removed; }, 0);
  return {
    status: 'success',
    message: buildSuccessMessage({ runAt: runAt, csvCount: names.length, detailRows: merged.details.length, removed: removed, skipped: skipped }),
  };
}

// ---- 内部処理 ----

/** AggregateFiles に渡す decode。getBlob() で受け取った Blob を文字にし、U+FFFD があればそのファイルの失敗として記録する */
function makeDecoder_(byBytes, decodeFailures) {
  return function (bytes, enc) {
    return decodeBytes_(byBytes, decodeFailures, bytes, enc);
  };
}

function decodeBytes_(byBytes, decodeFailures, bytes, enc) {
  var entry = byBytes.get(bytes);
  if (!entry) throw new Error('decodeBytes_: 読み込んだファイルと対応しないバイト列です');
  var text = entry.blob.getDataAsString(enc === ENCODING_SJIS ? SJIS_CHARSET : 'UTF-8');
  var line = findReplacementCharLine(text);
  if (line > 0) decodeFailures.push({ file: entry.name, line: line, message: DECODE_FAILURE_MESSAGE });
  return text;
}

/**
 * 出力の 5 つの名前のシートで、1 行目がこのツールの見出しと違う最初のもの。なければ null。
 * 戻り値: { name, header }（header は 1 行目の getLastColumn 列までの値）
 */
function findForeignOutputSheet_(ss) {
  for (var i = 0; i < OUTPUT_SHEETS.length; i++) {
    var sheet = ss.getSheetByName(OUTPUT_SHEETS[i]);
    if (!sheet) continue;
    var lastColumn = sheet.getLastColumn();
    var header = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
    if (!isOwnOutputSheet(OUTPUT_SHEETS[i], header)) return { name: OUTPUT_SHEETS[i], header: header };
  }
  return null;
}

function foreignSheetMessage_(found) {
  return foreignSheetMessage(found.name, found.header);
}

/**
 * 出力のシートを作り直す（仕様 4.3）。
 * 「（作成中）」の名前で全部書いて flush してから、5 つの名前の前回のシートを消し、名前を入れ替える。
 * 書いている途中の例外: 作ったシートを消して投げ直す（前回の結果は残る）。入れ替えの途中の例外: swapFailed を付けて投げる。
 * 書いている間に依頼者が同じ名前のシートを作ったら、作ったシートを消して、そのシートの名前を返す（何も変えない）。
 * 戻り値: 入れ替えたら null、止めたら findForeignOutputSheet_ の結果
 */
function replaceOutputSheets_(ss, tables) {
  OUTPUT_SHEETS.forEach(function (name) {
    var left = ss.getSheetByName(name + WORKING_SUFFIX);
    if (left) ss.deleteSheet(left);
  });
  // 「設定」のすぐ後ろ（insertSheet の位置は 0 から）。「設定」がなければ先頭（自己テストのスプレッドシートだけ。本番では必ずある）
  var settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  var position = settingsSheet ? settingsSheet.getIndex() : 0;
  var created = [];
  try {
    tables.forEach(function (t, i) {
      var sheet = ss.insertSheet(t.name + WORKING_SUFFIX, position + i);
      created.push(sheet);
      writeTable_(sheet, t);
    });
    SpreadsheetApp.flush();
  } catch (err) {
    deleteSheetsQuietly_(ss, created);
    throw err;
  }
  // 書いている間に依頼者が同じ名前のシートを作ることもあるので、消す直前にもう一度見る（仕様 4.3 の 4）
  var notOwn = findForeignOutputSheet_(ss);
  if (notOwn) {
    deleteSheetsQuietly_(ss, created);
    return notOwn;
  }
  try {
    OUTPUT_SHEETS.forEach(function (name) {
      var old = ss.getSheetByName(name);
      if (old) ss.deleteSheet(old);
    });
    created.forEach(function (sheet, i) { sheet.setName(tables[i].name); });
    created[0].activate();
  } catch (err) {
    var swapError = new Error('swap failed');
    swapError.swapFailed = true;
    swapError.cause = err;
    throw swapError;
  }
  return null;
}

/** 作った「（作成中）」のシートを消す。消せなくても止めない（次の実行の最初に消える） */
function deleteSheetsQuietly_(ss, sheets) {
  sheets.forEach(function (sheet) {
    try { ss.deleteSheet(sheet); } catch (e) { console.error(e); }
  });
}

/**
 * 1 枚のシートに書く。t: { name, values（見出しを含む）, tableRows（見出しの下の表の行数）, boldLastRow,
 * textBlockFrom・textBlockCols（表の下で文字として書く行と列の数） }
 * 文字の列は値を書く前に @ にする。setValues は 1 回だけ。
 */
function writeTable_(sheet, t) {
  var rows = t.values.length;
  var cols = t.values[0].length;
  var layout = OUTPUT_LAYOUT[t.name];
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
  if (sheet.getMaxColumns() > cols) sheet.deleteColumns(cols + 1, sheet.getMaxColumns() - cols);

  if (t.tableRows > 0) {
    layout.textCols.forEach(function (c) { sheet.getRange(2, c, t.tableRows, 1).setNumberFormat('@'); });
    (layout.numberCols || []).forEach(function (c) {
      var column = t.values.slice(1, t.tableRows + 1).map(function (r) { return r[c - 1]; });
      sheet.getRange(2, c, t.tableRows, 1).setNumberFormat(numberFormatFor(column));
    });
    (layout.integerCols || []).forEach(function (c) { sheet.getRange(2, c, t.tableRows, 1).setNumberFormat('0'); });
  }
  if (t.textBlockFrom && t.textBlockFrom <= rows) {
    sheet.getRange(t.textBlockFrom, 1, rows - t.textBlockFrom + 1, t.textBlockCols).setNumberFormat('@');
  }
  sheet.getRange(1, 1, rows, cols).setValues(t.values);
  styleHeader_(sheet.getRange(1, 1, 1, cols));
  if (t.boldLastRow) sheet.getRange(rows, 1, 1, cols).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, cols);
}

function styleHeader_(range) {
  range.setBackground(COLOR_HEADER).setFontWeight('bold');
}

function dropDown_(list) {
  return SpreadsheetApp.newDataValidation().requireValueInList(list, true).build();
}

/** 何も書かずに終えるときの結果。文に「シートは変えていません」がなければ足す */
function stopped_(message) {
  return { status: 'stopped', message: message.indexOf(NOT_CHANGED) === -1 ? message + '\n' + NOT_CHANGED : message };
}

function messageOf_(err) {
  return String(err && err.message || err);
}
