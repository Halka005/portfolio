/**
 * 問い合わせ・ヒアリング受付 自動化ツール
 * Google フォームの回答先スプレッドシートに紐づけて使う（コンテナバインド）。
 */

var SHEET_CONFIG = '設定';
var SHEET_LOG = 'ログ';
var COL_ID = '受付番号';
var COL_STATUS = 'ステータス';
var COL_PROCESSED_AT = '処理日時';
var STATUS_NEW = '未対応';
var STATUS_OPTIONS = ['未対応', '対応中', '完了', '対応不要'];

var REQUIRED_KEYS = ['EMAIL_FIELD', 'NAME_FIELD', 'NOTIFY_TO', 'REPLY_SUBJECT', 'REPLY_BODY'];

// 初期設定で作成する設定値: [キー, 値, 説明]
var DEFAULT_CONFIG = [
  ['DRY_RUN', 'TRUE', 'TRUE の間はメールを送らずログだけ残す。動作確認後に FALSE にする'],
  ['EMAIL_FIELD', 'メールアドレス', 'フォームのメールアドレスの質問名（完全一致）'],
  ['NAME_FIELD', 'お名前', 'フォームの名前の質問名（完全一致）'],
  ['NOTIFY_TO', '', '担当者の通知先メールアドレス（カンマ区切りで複数可）'],
  ['SENDER_NAME', 'お問い合わせ窓口', '自動返信メールの差出人名'],
  ['REPLY_SUBJECT', '【受付番号 {{受付番号}}】お問い合わせを受け付けました', '自動返信の件名。{{質問名}} で回答を差し込める'],
  ['REPLY_BODY', '{{お名前}} 様\n\nお問い合わせありがとうございます。\n以下の内容で受け付けました。2営業日以内にご連絡いたします。\n\n受付番号: {{受付番号}}\n\n{{回答一覧}}', '自動返信の本文'],
  ['NOTIFY_SUBJECT', '【新規受付】{{受付番号}} {{お名前}} 様', '担当者向け通知の件名'],
];

function onOpen() {
  var menu = SpreadsheetApp.getUi()
    .createMenu('受付ツール')
    .addItem('① 初期設定（シート作成）', 'setup')
    .addItem('② 自動実行を有効にする', 'installTrigger')
    .addSeparator()
    .addItem('自動実行を停止する', 'removeTriggers');
  // 開発用の自己テスト（selftest.js）を貼ったときだけ出す。納品物には selftest.js を入れないので出ない（docs/specs/selftest.md 3.2）
  if (typeof runSelfTest === 'function') menu.addSeparator().addItem('自己テスト（開発用）', 'runSelfTest');
  menu.addToUi();
}

/** 設定シートとログシートを作る。既にある場合は上書きしない */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName(SHEET_CONFIG)) {
    var config = ss.insertSheet(SHEET_CONFIG);
    config.getRange(1, 1, 1, 3).setValues([['キー', '値', '説明']])
      .setFontWeight('bold').setBackground('#e0e0e0');
    config.getRange(2, 1, DEFAULT_CONFIG.length, 3).setValues(DEFAULT_CONFIG);
    // 入力してよいセルは薄い黄色（docs/DESIGN.md のルール）
    config.getRange(2, 2, DEFAULT_CONFIG.length, 1).setBackground('#fff8c5').setWrap(true);
    config.setColumnWidth(1, 160);
    config.setColumnWidth(2, 360);
    config.setColumnWidth(3, 360);
    config.setFrozenRows(1);
  }

  if (!ss.getSheetByName(SHEET_LOG)) createLogSheet_(ss);

  SpreadsheetApp.getUi().alert(
    '初期設定が完了しました。\n「設定」シートの黄色いセルを入力してから、「② 自動実行を有効にする」を実行してください。'
  );
}

/** 「ログ」シートを作る（setup と自己テストから呼ぶ） */
function createLogSheet_(ss) {
  var log = ss.insertSheet(SHEET_LOG);
  log.getRange(1, 1, 1, 4).setValues([['日時', 'レベル', '受付番号', '内容']])
    .setFontWeight('bold').setBackground('#e0e0e0');
  log.setFrozenRows(1);
  return log;
}

/** フォーム送信時の自動実行を登録する（重複登録はしない） */
function installTrigger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onFormSubmit';
  });
  if (!exists) {
    ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  }
  SpreadsheetApp.getUi().alert(exists ? '自動実行は既に有効です。' : '自動実行を有効にしました。');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(t);
  });
  SpreadsheetApp.getUi().alert('自動実行を停止しました。');
}

/** フォーム送信時に呼ばれるメイン処理 */
function onFormSubmit(e) {
  handleFormSubmit_(e, null);
}

/**
 * 受付の中身。given: parseConfig の戻り値と同じ形の設定。null なら今どおり「設定」シートから読む。
 * 自己テストは「設定」シートを読まず書かないために、設定をここに渡す（docs/specs/selftest.md 3.2）。
 */
function handleFormSubmit_(e, given) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    writeLog_('ERROR', '', '他の処理が実行中のため受付処理をスキップしました（行 ' + e.range.getRow() + '）');
    return;
  }

  var inquiryId = '';
  try {
    var config = given || loadConfig_();
    var missing = missingConfigKeys(config, REQUIRED_KEYS);
    if (missing.length) {
      throw new Error('設定が未入力です: ' + missing.join(', '));
    }

    var sheet = e.range.getSheet();
    var row = e.range.getRow();
    var cols = ensureManagementColumns_(sheet);

    // 処理済みの行は何もしない（再実行しても二重送信しない）
    if (sheet.getRange(row, cols.id).getValue()) {
      writeLog_('INFO', '', '行 ' + row + ' は処理済みのためスキップしました');
      return;
    }

    var answers = flattenNamedValues(e.namedValues);
    inquiryId = issueInquiryId_(sheet, cols.id);

    var vars = Object.assign({}, answers, { '受付番号': inquiryId, '回答一覧': formatAnswers(answers) });
    var dryRun = config.DRY_RUN !== false;

    var email = answers[config.EMAIL_FIELD];
    if (isValidEmail(email)) {
      sendMail_(dryRun, {
        to: email.trim(),
        subject: renderTemplate(config.REPLY_SUBJECT, vars),
        body: renderTemplate(config.REPLY_BODY, vars),
        name: config.SENDER_NAME || '',
      }, inquiryId);
    } else {
      writeLog_('WARN', inquiryId, 'メールアドレスが不正なため自動返信を送りませんでした: ' + email);
    }

    sendMail_(dryRun, {
      to: config.NOTIFY_TO,
      subject: renderTemplate(config.NOTIFY_SUBJECT || '【新規受付】{{受付番号}}', vars),
      body: '新しい受付がありました。\n\n受付番号: ' + inquiryId + '\n\n' + formatAnswers(answers) +
        '\n\nスプレッドシート: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    }, inquiryId);

    sheet.getRange(row, cols.id).setValue(inquiryId);
    sheet.getRange(row, cols.status).setValue(STATUS_NEW);
    sheet.getRange(row, cols.processedAt).setValue(new Date());
    writeLog_('INFO', inquiryId, '受付処理が完了しました' + (dryRun ? '（DRY_RUN: メール未送信）' : ''));
  } catch (err) {
    writeLog_('ERROR', inquiryId, String(err && err.stack || err));
    notifyError_(err, inquiryId, given);
  } finally {
    lock.releaseLock();
  }
}

function loadConfig_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CONFIG);
  if (!sheet) throw new Error('「設定」シートがありません。メニューの「① 初期設定」を実行してください。');
  var last = sheet.getLastRow();
  if (last < 2) return {};
  return parseConfig(sheet.getRange(2, 1, last - 1, 2).getValues());
}

/**
 * 管理用の列（受付番号・ステータス・処理日時）を見出し名で探し、なければ右端に追加する。
 * フォームの質問が増えて列がずれても、見出し名で探すので壊れない。
 */
function ensureManagementColumns_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var result = {};
  [[COL_ID, 'id'], [COL_STATUS, 'status'], [COL_PROCESSED_AT, 'processedAt']].forEach(function (pair) {
    var idx = headers.indexOf(pair[0]);
    if (idx === -1) {
      lastCol += 1;
      sheet.getRange(1, lastCol).setValue(pair[0]).setFontWeight('bold').setBackground('#e0e0e0');
      headers.push(pair[0]);
      idx = lastCol - 1;
      if (pair[1] === 'status') {
        var rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).build();
        sheet.getRange(2, lastCol, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
      }
    }
    result[pair[1]] = idx + 1;
  });
  return result;
}

function issueInquiryId_(sheet, idCol) {
  var last = sheet.getLastRow();
  var ids = last < 2 ? [] : sheet.getRange(2, idCol, last - 1, 1).getValues().map(function (r) { return r[0]; });
  return nextInquiryId(ids, formatDateKey(new Date()));
}

function sendMail_(dryRun, mail, inquiryId) {
  if (dryRun) {
    writeLog_('INFO', inquiryId, '[DRY_RUN] 送信予定: ' + mail.to + ' / ' + mail.subject);
    return;
  }
  MailApp.sendEmail(mail);
  writeLog_('INFO', inquiryId, '送信しました: ' + mail.to + ' / ' + mail.subject);
}

/** given: 渡された設定。null なら「設定」シートから読む */
function notifyError_(err, inquiryId, given) {
  try {
    var config = given || loadConfig_();
    if (config.DRY_RUN === false && config.NOTIFY_TO) {
      MailApp.sendEmail(config.NOTIFY_TO, '【受付ツール】エラーが発生しました ' + inquiryId,
        'ログシートを確認してください。\n\n' + String(err));
    }
  } catch (ignored) {
    // 通知自体の失敗はログ済みのエラーを優先する
  }
}

function writeLog_(level, inquiryId, message) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if (!sheet) {
    console.log(level + ' ' + inquiryId + ' ' + message);
    return;
  }
  sheet.appendRow([new Date(), level, inquiryId, message]);
}
