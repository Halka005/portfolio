/**
 * 請求書 PDF 自動作成ツール
 * スプレッドシートの「請求明細」から顧客ごとに請求書 PDF を作り、Google ドライブに保存して、
 * Gmail の下書き（PDF 添付）まで用意する。メールは自動送信しない（人が確認して送る）。
 */

var SHEET = {
  CONFIG: '設定',
  CUSTOMERS: '顧客',
  ITEMS: '請求明細',
  HISTORY: '発行履歴',
  LOG: 'ログ',
};
var HEADERS = {
  CUSTOMERS: ['顧客ID', '会社名', '敬称', '担当者名', 'メールアドレス'],
  ITEMS: ['請求月', '顧客ID', '品目', '数量', '単価', '税率'],
  HISTORY: ['請求月', '顧客ID', '請求書番号', '請求金額', 'PDF', 'Gmail下書き', '作成日時'],
  LOG: ['日時', 'レベル', '内容'],
};
var COLOR_HEADER = '#e0e0e0';
var COLOR_INPUT = '#fff8c5';

var REQUIRED_KEYS = ['ISSUER_NAME', 'ISSUER_ADDRESS', 'BANK_INFO', 'PAYMENT_TERMS', 'MAIL_SUBJECT', 'MAIL_BODY'];

// [キー, 値, 説明]
var DEFAULT_CONFIG = [
  ['DRY_RUN', 'TRUE', 'TRUE の間は確認用 PDF だけ作り、下書きと発行履歴は作らない'],
  ['ISSUER_NAME', 'サンプル事務所', '請求書に載せる自社名・屋号'],
  ['ISSUER_ADDRESS', '〒000-0000 東京都サンプル区1-2-3', '住所'],
  ['ISSUER_EMAIL', 'billing@example.com', '連絡先メールアドレス（任意）'],
  ['REGISTRATION_NUMBER', '', '適格請求書発行事業者の登録番号（T + 13 桁）。未登録なら空欄'],
  ['BANK_INFO', 'サンプル銀行 本店 普通 1234567\nサンプルジムショ', '振込先'],
  ['PAYMENT_TERMS', '翌月末', '支払期限:「翌月末」「当月末」または発行日からの日数'],
  ['ROUNDING', 'floor', '端数処理: floor（切り捨て）/ round（四捨五入）/ ceil（切り上げ）'],
  ['FOLDER_ID', '', 'PDF の保存先フォルダの ID。空欄なら初回に「請求書」フォルダを自動作成'],
  ['MAIL_SUBJECT', '【請求書】{{請求月}}分 {{請求書番号}}', 'メール件名。{{会社名}} {{担当者名}} {{請求月}} {{請求書番号}} {{請求金額}} {{支払期限}} が使える'],
  ['MAIL_BODY', '{{会社名}}\n{{担当者名}} 様\n\nいつもお世話になっております。\n{{請求月}}分の請求書をお送りします。\n\nご請求金額: {{請求金額}}\nお支払期限: {{支払期限}}\n\nご確認のほど、よろしくお願いいたします。', 'メール本文'],
  ['NOTE', '', '請求書の備考（任意）'],
];

function onOpen() {
  var menu = SpreadsheetApp.getUi()
    .createMenu('請求書ツール')
    .addItem('① 初期設定（シート作成）', 'setup')
    .addItem('サンプルデータを入れる', 'insertSampleData')
    .addSeparator()
    .addItem('② 請求書を作成する', 'createInvoices');
  // 開発用の自己テスト（selftest.js）を貼ったときだけ出す。納品物には selftest.js を入れないので出ない（docs/specs/selftest.md 3.2）
  if (typeof runSelfTest === 'function') menu.addSeparator().addItem('自己テスト（開発用）', 'runSelfTest');
  menu.addToUi();
}

/** 必要なシートを作る。既にあるシートは上書きしない */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName(SHEET.CONFIG)) {
    var config = ss.insertSheet(SHEET.CONFIG);
    styleHeader_(config.getRange(1, 1, 1, 3).setValues([['キー', '値', '説明']]));
    config.getRange(2, 1, DEFAULT_CONFIG.length, 3).setValues(DEFAULT_CONFIG);
    config.getRange(2, 2, DEFAULT_CONFIG.length, 1).setBackground(COLOR_INPUT).setWrap(true);
    config.setColumnWidth(1, 180);
    config.setColumnWidth(2, 340);
    config.setColumnWidth(3, 420);
    config.setFrozenRows(1);
  }
  createTableSheet_(ss, SHEET.CUSTOMERS, HEADERS.CUSTOMERS, true);
  createTableSheet_(ss, SHEET.ITEMS, HEADERS.ITEMS, true);
  createTableSheet_(ss, SHEET.HISTORY, HEADERS.HISTORY, false);
  createTableSheet_(ss, SHEET.LOG, HEADERS.LOG, false);

  SpreadsheetApp.getUi().alert(
    '初期設定が完了しました。\n「設定」「顧客」「請求明細」シートの黄色い部分を入力してから、「② 請求書を作成する」を実行してください。'
  );
}

/** 動作確認用のダミーデータを入れる */
function insertSampleData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ym = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var data = sampleData(ym);
  appendRows_(ss.getSheetByName(SHEET.CUSTOMERS), data.customers);
  appendRows_(ss.getSheetByName(SHEET.ITEMS), data.items);
  SpreadsheetApp.getUi().alert('サンプルデータを入れました（請求月: ' + ym + '）。');
}

/** メニューから実行: 請求月を聞いて請求書を作る */
function createInvoices() {
  var ui = SpreadsheetApp.getUi();
  var defaultYm = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var res = ui.prompt('請求書を作成', '請求月を入力してください（例: ' + defaultYm + '）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  var ym = normalizeYearMonth(res.getResponseText() || defaultYm);
  if (!ym) {
    ui.alert('請求月の形式が正しくありません（例: ' + defaultYm + '）');
    return;
  }
  var result = runInvoices(ym, new Date());
  ui.alert(result.message);
}

/**
 * 指定した請求月の請求書をまとめて作る。
 * 発行履歴にある（請求月, 顧客ID）は作り直さないので、何度実行しても二重発行しない。
 * @return {{created: number, skipped: number, message: string}}
 */
function runInvoices(yearMonth, issueDate) {
  return runInvoicesWith_(yearMonth, issueDate, null);
}

/**
 * runInvoices の中身。given: loadConfig_ の戻り値と同じ形の設定。null なら今どおり「設定」シートから読む。
 * 自己テストは「設定」シートを読まず書かないために、設定をここに渡す（docs/specs/selftest.md 3.2）。
 * yearMonth は正規化した形（'202610'）で受け取る。
 */
function runInvoicesWith_(yearMonth, issueDate, given) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    return { created: 0, skipped: 0, message: '他の処理が実行中です。少し待ってから再実行してください。' };
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var config = given || loadConfig_(ss);
    var missing = REQUIRED_KEYS.filter(function (k) { return config[k] === undefined || config[k] === ''; });
    if (missing.length) throw new Error('設定が未入力です: ' + missing.join(', '));
    if (config.REGISTRATION_NUMBER && !isValidRegistrationNumber(config.REGISTRATION_NUMBER)) {
      throw new Error('登録番号の形式が正しくありません（T + 13 桁）: ' + config.REGISTRATION_NUMBER);
    }
    var dryRun = config.DRY_RUN !== false;

    var customers = readTable_(ss.getSheetByName(SHEET.CUSTOMERS));
    var customerById = {};
    customers.forEach(function (c) { customerById[String(c['顧客ID'])] = c; });

    var items = readTable_(ss.getSheetByName(SHEET.ITEMS))
      .filter(function (r) { return normalizeYearMonth(r['請求月']) === yearMonth; })
      .map(function (r) {
        return {
          rowNumber: r._row,
          customerId: String(r['顧客ID'] || '').trim(),
          name: String(r['品目'] || '').trim(),
          quantity: r['数量'],
          unitPrice: r['単価'],
          taxRate: r['税率'],
        };
      });
    if (!items.length) {
      return { created: 0, skipped: 0, message: displayYm_(yearMonth) + ' の請求明細がありません。' };
    }

    // 1 行でも不備があれば、1 枚も作らずに止める（中途半端な発行を防ぐ）
    var errors = validateItems(items, Object.keys(customerById));
    if (errors.length) throw new Error('請求明細に不備があります。\n' + errors.join('\n'));

    var historySheet = ss.getSheetByName(SHEET.HISTORY);
    var history = readTable_(historySheet);
    var issued = {};
    history.forEach(function (h) { issued[normalizeYearMonth(h['請求月']) + '|' + h['顧客ID']] = true; });
    var numbers = history.map(function (h) { return h['請求書番号']; });

    var folder = dryRun ? null : getFolder_(ss, config);
    var dueDate = calcDueDate(issueDate, config.PAYMENT_TERMS);
    var created = 0;
    var skipped = 0;
    var lines = [];

    groupByCustomer(items).forEach(function (group) {
      var customer = customerById[group.customerId];
      if (issued[yearMonth + '|' + group.customerId]) {
        skipped += 1;
        lines.push('スキップ（発行済み）: ' + customer['会社名']);
        return;
      }

      var invoiceNumber = nextInvoiceNumber(numbers, yearMonth);
      var calc = calcInvoice(group.items, config.ROUNDING);
      var html = renderInvoiceHtml({
        invoiceNumber: invoiceNumber,
        issueDate: issueDate,
        dueDate: dueDate,
        calc: calc,
        note: config.NOTE,
        customer: { name: customer['会社名'], honorific: customer['敬称'], contact: customer['担当者名'] },
        issuer: {
          name: config.ISSUER_NAME,
          address: config.ISSUER_ADDRESS,
          email: config.ISSUER_EMAIL,
          registrationNumber: config.REGISTRATION_NUMBER,
          bank: config.BANK_INFO,
        },
      });
      var fileName = safeFileName((dryRun ? '[確認用]' : '') + invoiceNumber + '_' + customer['会社名'] + '.pdf');
      var pdf = Utilities.newBlob(html, 'text/html', 'invoice.html').getAs('application/pdf').setName(fileName);

      if (dryRun) {
        var preview = DriveApp.createFile(pdf);
        numbers.push(invoiceNumber);
        log_('INFO', '[DRY_RUN] 確認用 PDF を作成: ' + preview.getUrl());
        lines.push('確認用 PDF: ' + customer['会社名'] + ' ' + formatYen(calc.total));
        created += 1;
        return;
      }

      var file = folder.createFile(pdf);
      var draftStatus = '未作成';
      var email = String(customer['メールアドレス'] || '');
      if (isValidEmail(email)) {
        var vars = {
          '会社名': customer['会社名'],
          '担当者名': customer['担当者名'],
          '請求月': displayYm_(yearMonth),
          '請求書番号': invoiceNumber,
          '請求金額': formatYen(calc.total),
          '支払期限': formatDateJa(dueDate),
        };
        GmailApp.createDraft(email.trim(),
          renderTemplate(config.MAIL_SUBJECT, vars),
          renderTemplate(config.MAIL_BODY, vars),
          { attachments: [pdf], name: config.ISSUER_NAME });
        draftStatus = '作成済み';
      } else {
        log_('WARN', 'メールアドレスが不正なため下書きを作りませんでした: ' + customer['会社名']);
      }

      historySheet.appendRow(["'" + displayYm_(yearMonth), group.customerId, invoiceNumber, calc.total,
        file.getUrl(), draftStatus, new Date()]);
      numbers.push(invoiceNumber);
      log_('INFO', '請求書を作成: ' + invoiceNumber + ' ' + customer['会社名'] + ' ' + formatYen(calc.total));
      lines.push(invoiceNumber + ': ' + customer['会社名'] + ' ' + formatYen(calc.total) + (draftStatus === '作成済み' ? '（下書き作成）' : '（下書きなし）'));
      created += 1;
    });

    var head = dryRun
      ? '【お試しモード】確認用 PDF をマイドライブに作成しました。下書きと発行履歴は作っていません。'
      : '請求書を作成しました。Gmail の下書きを確認してから送信してください。';
    return { created: created, skipped: skipped, message: head + '\n\n' + lines.join('\n') };
  } catch (err) {
    log_('ERROR', String(err && err.stack || err));
    return { created: 0, skipped: 0, message: 'エラー: ' + (err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

// ---- 内部処理 ----

function displayYm_(ym) {
  return ym.slice(0, 4) + '-' + ym.slice(4);
}

function loadConfig_(ss) {
  var sheet = ss.getSheetByName(SHEET.CONFIG);
  if (!sheet) throw new Error('「設定」シートがありません。メニューの「① 初期設定」を実行してください。');
  var last = sheet.getLastRow();
  if (last < 2) return {};
  return parseConfigRows(sheet.getRange(2, 1, last - 1, 2).getValues());
}

/** 1 行目を見出しとして、各行を {見出し: 値, _row: 行番号} にする。空行は飛ばす */
function readTable_(sheet) {
  if (!sheet) throw new Error('必要なシートがありません。メニューの「① 初期設定」を実行してください。');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].every(function (v) { return v === '' || v === null; })) continue;
    var obj = { _row: i + 1 };
    headers.forEach(function (h, j) { obj[h] = values[i][j]; });
    rows.push(obj);
  }
  return rows;
}

function getFolder_(ss, config) {
  if (config.FOLDER_ID) return DriveApp.getFolderById(config.FOLDER_ID);
  var folder = DriveApp.createFolder('請求書');
  setConfigValue_(ss, 'FOLDER_ID', folder.getId());
  log_('INFO', '保存先フォルダを作成しました: ' + folder.getUrl());
  return folder;
}

function setConfigValue_(ss, key, value) {
  var sheet = ss.getSheetByName(SHEET.CONFIG);
  var keys = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
}

function createTableSheet_(ss, name, headers, isInput) {
  if (ss.getSheetByName(name)) return;
  var sheet = ss.insertSheet(name);
  styleHeader_(sheet.getRange(1, 1, 1, headers.length).setValues([headers]));
  sheet.setFrozenRows(1);
  if (isInput) sheet.getRange(2, 1, 200, headers.length).setBackground(COLOR_INPUT);
}

function styleHeader_(range) {
  range.setFontWeight('bold').setBackground(COLOR_HEADER);
}

function appendRows_(sheet, rows) {
  if (!sheet) throw new Error('先に「① 初期設定」を実行してください。');
  rows.forEach(function (r) { sheet.appendRow(r); });
}

function log_(level, message) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.LOG);
  if (!sheet) {
    console.log(level + ' ' + message);
    return;
  }
  sheet.appendRow([new Date(), level, message]);
}
