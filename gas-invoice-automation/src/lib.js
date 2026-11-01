/**
 * 純粋関数（Google のサービスに依存しない処理）。
 * GAS ではグローバル関数として、Node.js ではテスト用に module.exports で読み込む。
 */

/** 端数処理。mode: 'floor'（切り捨て・既定）/ 'round'（四捨五入）/ 'ceil'（切り上げ） */
function roundYen(value, mode) {
  if (mode === 'round') return Math.round(value);
  if (mode === 'ceil') return Math.ceil(value);
  return Math.floor(value);
}

/**
 * 明細から請求金額を計算する。
 * 適格請求書（インボイス）のルールに合わせ、消費税は「税率ごとに合計してから 1 回だけ」端数処理する。
 * items: [{ name, quantity, unitPrice, taxRate }]（taxRate は 10 や 8 のような % の数値）
 */
function calcInvoice(items, roundingMode) {
  var lines = items.map(function (item) {
    return {
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate,
      amount: roundYen(item.quantity * item.unitPrice, roundingMode),
    };
  });

  var byRate = {};
  lines.forEach(function (line) {
    byRate[line.taxRate] = (byRate[line.taxRate] || 0) + line.amount;
  });

  var taxes = Object.keys(byRate)
    .map(Number)
    .sort(function (a, b) { return b - a; })
    .map(function (rate) {
      return { taxRate: rate, subtotal: byRate[rate], tax: roundYen(byRate[rate] * rate / 100, roundingMode) };
    });

  var subtotal = taxes.reduce(function (s, t) { return s + t.subtotal; }, 0);
  var tax = taxes.reduce(function (s, t) { return s + t.tax; }, 0);
  return { lines: lines, taxes: taxes, subtotal: subtotal, tax: tax, total: subtotal + tax };
}

/**
 * 明細の入力チェック。問題のある行の説明を配列で返す（空配列なら問題なし）。
 * rows: [{ rowNumber, customerId, name, quantity, unitPrice, taxRate }]
 */
function validateItems(rows, customerIds) {
  var errors = [];
  rows.forEach(function (r) {
    var where = r.rowNumber + ' 行目: ';
    if (!r.customerId) errors.push(where + '顧客ID が空です');
    else if (customerIds.indexOf(r.customerId) === -1) errors.push(where + '顧客ID「' + r.customerId + '」が顧客シートにありません');
    if (!r.name) errors.push(where + '品目が空です');
    if (typeof r.quantity !== 'number' || !(r.quantity > 0)) errors.push(where + '数量は 0 より大きい数値にしてください');
    if (typeof r.unitPrice !== 'number' || r.unitPrice < 0) errors.push(where + '単価は 0 以上の数値にしてください');
    if ([10, 8, 0].indexOf(r.taxRate) === -1) errors.push(where + '税率は 10 / 8 / 0 のいずれかにしてください');
  });
  return errors;
}

/** 明細を顧客IDごとにまとめる（出現順を保つ） */
function groupByCustomer(rows) {
  var order = [];
  var groups = {};
  rows.forEach(function (r) {
    if (!groups[r.customerId]) {
      groups[r.customerId] = [];
      order.push(r.customerId);
    }
    groups[r.customerId].push(r);
  });
  return order.map(function (id) { return { customerId: id, items: groups[id] }; });
}

/** 既存の請求書番号から、その月の次の番号を作る。例: INV-202610-001 */
function nextInvoiceNumber(existingNumbers, yearMonth) {
  var head = 'INV-' + yearMonth + '-';
  var max = 0;
  (existingNumbers || []).forEach(function (no) {
    if (typeof no !== 'string' || no.indexOf(head) !== 0) return;
    var n = parseInt(no.slice(head.length), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return head + ('00' + (max + 1)).slice(-3);
}

/**
 * "2026-10" / "202610" / "2026/10" / 日付オブジェクトを "202610" にする。不正なら null。
 * スプレッドシートは「2026-10」を日付に自動変換することがあるため、日付も受け付ける。
 */
function normalizeYearMonth(input) {
  if (Object.prototype.toString.call(input) === '[object Date]') {
    if (isNaN(input.getTime())) return null;
    return input.getFullYear() + ('0' + (input.getMonth() + 1)).slice(-2);
  }
  // 文字列として保存するための先頭の ' は取り除く
  var m = String(input || '').trim().replace(/^'/, '').match(/^(\d{4})[-/]?(\d{1,2})$/);
  if (!m) return null;
  var month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return m[1] + ('0' + month).slice(-2);
}

/**
 * 支払期限を計算する。
 * terms: '翌月末' / '当月末' / 数値（発行日からの日数）
 */
function calcDueDate(issueDate, terms) {
  var y = issueDate.getFullYear();
  var m = issueDate.getMonth();
  if (terms === '翌月末') return new Date(y, m + 2, 0);
  if (terms === '当月末') return new Date(y, m + 1, 0);
  var days = Number(terms);
  if (!isNaN(days) && days >= 0) return new Date(y, m, issueDate.getDate() + days);
  throw new Error('支払条件は「翌月末」「当月末」または日数で指定してください: ' + terms);
}

/** 適格請求書発行事業者の登録番号（T + 13 桁）の形式チェック */
function isValidRegistrationNumber(value) {
  return /^T\d{13}$/.test(String(value || '').trim());
}

/** 簡易的なメールアドレス形式チェック */
function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function formatYen(n) {
  return '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDateJa(date) {
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** {{キー}} を値で置き換える（メール本文用）。値がないキーは空文字にする */
function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([^}\s]+)\s*\}\}/g, function (_, key) {
    var v = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
    return v === null || v === undefined ? '' : String(v);
  });
}

/**
 * 請求書の HTML を作る（GAS で PDF に変換する）。
 * 外部の CSS や画像は使わない（GAS の PDF 変換で確実に表示できる範囲に限定）。
 */
function renderInvoiceHtml(d) {
  var e = escapeHtml;
  var rows = d.calc.lines.map(function (l) {
    return '<tr><td>' + e(l.name) + (l.taxRate === 8 ? ' ※' : '') + '</td>' +
      '<td class="num">' + e(l.quantity) + '</td>' +
      '<td class="num">' + formatYen(l.unitPrice) + '</td>' +
      '<td class="num">' + l.taxRate + '%</td>' +
      '<td class="num">' + formatYen(l.amount) + '</td></tr>';
  }).join('');
  var taxRows = d.calc.taxes.map(function (t) {
    return '<tr><td>' + t.taxRate + '% 対象</td><td class="num">' + formatYen(t.subtotal) +
      '</td><td>消費税</td><td class="num">' + formatYen(t.tax) + '</td></tr>';
  }).join('');
  var hasReduced = d.calc.lines.some(function (l) { return l.taxRate === 8; });

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{font-family:sans-serif;font-size:11px;color:#222;margin:32px;}' +
    'h1{font-size:22px;text-align:center;letter-spacing:8px;margin:0 0 24px;}' +
    '.top{width:100%;margin-bottom:16px;} .top td{vertical-align:top;}' +
    '.to{font-size:15px;border-bottom:1px solid #222;padding-bottom:4px;}' +
    '.right{text-align:right;line-height:1.7;}' +
    '.total{font-size:16px;margin:16px 0;border:2px solid #222;padding:8px 12px;display:inline-block;}' +
    'table.items,table.tax{width:100%;border-collapse:collapse;margin-top:8px;}' +
    'table.items th,table.items td,table.tax td{border:1px solid #999;padding:5px 7px;}' +
    'table.items th{background:#eee;font-weight:bold;}' +
    '.num{text-align:right;white-space:nowrap;} .note{margin-top:16px;line-height:1.7;}' +
    '</style></head><body>' +
    '<h1>請求書</h1>' +
    '<table class="top"><tr><td>' +
    '<div class="to">' + e(d.customer.name) + ' ' + e(d.customer.honorific || '御中') + '</div>' +
    (d.customer.contact ? '<div>' + e(d.customer.contact) + ' 様</div>' : '') +
    '<p>下記のとおりご請求申し上げます。</p>' +
    '</td><td class="right">' +
    '請求書番号: ' + e(d.invoiceNumber) + '<br>' +
    '発行日: ' + e(formatDateJa(d.issueDate)) + '<br>' +
    '<br><strong>' + e(d.issuer.name) + '</strong><br>' +
    e(d.issuer.address) + '<br>' +
    (d.issuer.registrationNumber ? '登録番号: ' + e(d.issuer.registrationNumber) + '<br>' : '') +
    (d.issuer.email ? e(d.issuer.email) : '') +
    '</td></tr></table>' +
    '<div class="total">ご請求金額（税込） ' + formatYen(d.calc.total) + '</div>' +
    '<div>お支払期限: ' + e(formatDateJa(d.dueDate)) + '</div>' +
    '<table class="items"><tr><th>品目</th><th>数量</th><th>単価</th><th>税率</th><th>金額（税抜）</th></tr>' +
    rows + '</table>' +
    '<table class="tax">' + taxRows +
    '<tr><td colspan="3"><strong>合計（税込）</strong></td><td class="num"><strong>' + formatYen(d.calc.total) + '</strong></td></tr>' +
    '</table>' +
    (hasReduced ? '<div>※ は軽減税率（8%）対象</div>' : '') +
    '<div class="note"><strong>お振込先</strong><br>' + e(d.issuer.bank).replace(/\n/g, '<br>') +
    '<br>振込手数料はご負担くださいますようお願いいたします。</div>' +
    (d.note ? '<div class="note">' + e(d.note).replace(/\n/g, '<br>') + '</div>' : '') +
    '</body></html>';
}

/** ファイル名に使えない文字を除く */
function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
}

/**
 * 「設定」シートの行（[キー, 値, 説明]）を設定のオブジェクトにする。キーが空の行は飛ばす。
 * 文字の値だけ前後の空白を除き、TRUE / FALSE（大文字・小文字は問わない）を真偽値にする。
 * 真偽値・数・日付はそのまま残す（Sheets はセルの TRUE を真偽値で返すため）。
 */
function parseConfigRows(rows) {
  var config = {};
  (rows || []).forEach(function (row) {
    var key = String(row[0] || '').trim();
    if (!key) return;
    var v = row[1];
    if (typeof v === 'string') {
      v = v.trim();
      if (v.toUpperCase() === 'TRUE') v = true;
      else if (v.toUpperCase() === 'FALSE') v = false;
    }
    config[key] = v;
  });
  return config;
}

/**
 * 動作確認用のダミーデータ。ym は '2026-10' の形。
 * 戻り値: { customers: 「顧客」の行, items: 「請求明細」の行 }。請求月は文字として保存するため先頭に ' を付ける。
 */
function sampleData(ym) {
  return {
    customers: [
      ['C001', '株式会社サンプル商事', '御中', '山田 太郎', 'yamada@example.com'],
      ['C002', 'テスト合同会社', '御中', '佐藤 花子', 'sato@example.com'],
    ],
    items: [
      ["'" + ym, 'C001', 'Web サイト保守（月額）', 1, 30000, 10],
      ["'" + ym, 'C001', '更新作業', 3, 5000, 10],
      ["'" + ym, 'C002', 'データ入力代行', 120, 50, 10],
      ["'" + ym, 'C002', '打ち合わせ用 茶菓子', 1, 1080, 8],
    ],
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    roundYen: roundYen,
    calcInvoice: calcInvoice,
    validateItems: validateItems,
    groupByCustomer: groupByCustomer,
    nextInvoiceNumber: nextInvoiceNumber,
    normalizeYearMonth: normalizeYearMonth,
    calcDueDate: calcDueDate,
    isValidRegistrationNumber: isValidRegistrationNumber,
    isValidEmail: isValidEmail,
    formatYen: formatYen,
    formatDateJa: formatDateJa,
    escapeHtml: escapeHtml,
    renderTemplate: renderTemplate,
    renderInvoiceHtml: renderInvoiceHtml,
    safeFileName: safeFileName,
    parseConfigRows: parseConfigRows,
    sampleData: sampleData,
  };
}
