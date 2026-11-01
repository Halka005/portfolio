/**
 * 純粋関数（Google のサービスに依存しない処理）。
 * GAS ではグローバル関数として、Node.js ではテスト用に module.exports で読み込む。
 */

/** 日付を yyyyMMdd 形式にする（タイムゾーン変換は呼び出し側で済ませる） */
function formatDateKey(date) {
  var y = date.getFullYear();
  var m = ('0' + (date.getMonth() + 1)).slice(-2);
  var d = ('0' + date.getDate()).slice(-2);
  return '' + y + m + d;
}

/**
 * 既存の受付番号一覧から、その日の次の受付番号を作る。
 * 例: INQ-20261013-001
 */
function nextInquiryId(existingIds, dateKey, prefix) {
  prefix = prefix || 'INQ';
  var head = prefix + '-' + dateKey + '-';
  var max = 0;
  (existingIds || []).forEach(function (id) {
    if (typeof id !== 'string' || id.indexOf(head) !== 0) return;
    var n = parseInt(id.slice(head.length), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return head + ('00' + (max + 1)).slice(-3);
}

/** {{キー}} を値で置き換える。値がないキーは空文字にする */
function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([^}\s]+)\s*\}\}/g, function (_, key) {
    var v = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
    return v === null || v === undefined ? '' : String(v);
  });
}

/** 簡易的なメールアドレス形式チェック（送信可否の判定用） */
function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * 設定シートの [[キー, 値], ...] をオブジェクトにする。
 * "TRUE"/"FALSE" は真偽値に変換し、空のキーは無視する。
 */
function parseConfig(rows) {
  var config = {};
  (rows || []).forEach(function (row) {
    var key = String(row[0] || '').trim();
    if (!key) return;
    var value = row[1];
    if (typeof value === 'string') {
      var upper = value.trim().toUpperCase();
      if (upper === 'TRUE') value = true;
      else if (upper === 'FALSE') value = false;
      else value = value.trim();
    }
    config[key] = value;
  });
  return config;
}

/** 必須の設定項目のうち、未入力のものを返す */
function missingConfigKeys(config, requiredKeys) {
  return requiredKeys.filter(function (key) {
    var v = config[key];
    return v === undefined || v === null || v === '';
  });
}

/**
 * フォーム送信イベントの namedValues（{質問: [回答]}）を {質問: 回答} にする。
 * 複数選択の回答はカンマ区切りで結合する。
 */
function flattenNamedValues(namedValues) {
  var answers = {};
  Object.keys(namedValues || {}).forEach(function (question) {
    var v = namedValues[question];
    answers[question] = Array.isArray(v) ? v.join(', ') : String(v);
  });
  return answers;
}

/** 回答を「質問: 回答」の一覧テキストにする（通知メール用） */
function formatAnswers(answers) {
  return Object.keys(answers)
    .map(function (q) { return '■ ' + q + '\n' + answers[q]; })
    .join('\n\n');
}

if (typeof module !== 'undefined') {
  module.exports = {
    formatDateKey: formatDateKey,
    nextInquiryId: nextInquiryId,
    renderTemplate: renderTemplate,
    isValidEmail: isValidEmail,
    parseConfig: parseConfig,
    missingConfigKeys: missingConfigKeys,
    flattenNamedValues: flattenNamedValues,
    formatAnswers: formatAnswers,
  };
}
