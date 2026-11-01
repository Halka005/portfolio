/**
 * 参照実装（純粋関数）。
 * Excel VBA（src/CsvAggregator.bas）の Private 関数と同じ名前・同じ手順で書いている。
 * VBA は CI で動かせないため、集計のルールはこのファイルとテストで固め、
 * 同じテストケース（tests/cases/）を VBA の手動テストでも使う。
 */

var ENCODING_UTF8_BOM = 'UTF-8（BOM あり）';
var ENCODING_UTF8 = 'UTF-8';
var ENCODING_SJIS = 'Shift_JIS';
var ENCODING_UTF16 = 'UTF-16';
var MAX_DETAIL_ROWS = 1048575; // シートの上限 1,048,576 行 − 見出し 1 行
var UNCLOSED_QUOTE_MESSAGE = '引用符（"）が閉じていません。この行で始まった引用符がファイルの終わりまで続いているため、後ろの行を読めません';
var UTF16_MESSAGE = 'UTF-16 には対応していません。UTF-8 か Shift_JIS で保存し直してください';
// 迷子の引用符（仕様 5.5）。{…} を QuoteTailMessage・QuoteCommaMessage で置き換える。波ダッシュは使わない（Shift_JIS 変換で文字が変わるため）
var QUOTE_TAIL_MESSAGE = '{startLine} 行目の「{column}」で始まった引用符（"）が {endLine} 行目で閉じたあと、すぐ後ろに文字が続いています。{startLine} 行目から {endLine} 行目までが 1 つの値として読まれ、行が消えている可能性があります。{startLine} 行目と {endLine} 行目に余分な " がないか確かめてください（値の中に " を書くときは "" と 2 つ重ねます）';
var QUOTE_COMMA_MESSAGE = '{startLine} 行目の「{column}」で始まった引用符（"）の中に、改行が {newlines} 個とカンマが {commas} 個あり、1 行分以上のデータが入っているように見えます。{startLine} 行目から {endLine} 行目までが 1 つの値として読まれ、行が消えている可能性があります。{startLine} 行目と {endLine} 行目に余分な " がないか確かめてください。値の中に本当にカンマの多い複数行の文がある場合は、「設定」シートの QUOTE_CHECK を FALSE にしてください';

/** UTF-8 として正しいバイト列か（RFC 3629。過長表現・サロゲート・途中で切れたものは不正） */
function IsValidUtf8(bytes) {
  var i = 0;
  var n = bytes.length;
  while (i < n) {
    var b = bytes[i];
    var need;
    var min;
    if (b < 0x80) { i++; continue; }
    if (b >= 0xc2 && b <= 0xdf) { need = 1; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; min = 0x10000; }
    else return false;
    if (i + need > n - 1) return false; // 途中で切れている
    var cp = b & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    for (var k = 1; k <= need; k++) {
      var c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return false;
      cp = cp * 64 + (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

/** 先頭が UTF-16 の BOM（FF FE か FE FF）か。UTF-16 のファイルは読まずにエラーにする */
function HasUtf16Bom(bytes) {
  if (bytes.length < 2) return false;
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

/** 文字コードの判定: BOM → UTF-8 として正しいか → Shift_JIS */
function DetectEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return ENCODING_UTF8_BOM;
  if (IsValidUtf8(bytes)) return ENCODING_UTF8;
  return ENCODING_SJIS;
}

/** 先頭の BOM（U+FEFF）を 1 文字だけ取り除く */
function StripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * CSV を分解する（RFC 4180 に沿い、少し寛容に読む）。
 * 改行は CRLF・LF・CR のどれでもよい。引用符の中のカンマ・改行・"" を扱う。
 * 引用符の中の改行は LF にそろえて値に残す（ファイルの改行コードが違っても同じ値になるように。Excel のセル内改行も LF）。
 * 戻り値: [{ line: その行が始まる物理的な行番号（1 から）, fields: [文字列], unclosedQuoteLine: 0, quoteTail: null }]
 * 引用符が閉じないままファイルが終わったときは、最後のレコードの unclosedQuoteLine に
 * その引用符が始まった行番号を入れる（それ以外は 0）。NormalizeRows がエラーにする。
 * 判定 A（仕様 5.5）: 改行を含む引用符の値で、閉じた " の後ろ（空白は読み飛ばす）が , ・改行・ファイルの終わり以外なら、
 * quoteTail に { startLine: 引用符が始まった行, endLine: 閉じた行, field: 0 から数えた列 } を入れる（最初の 1 つだけ）。
 * 読み方そのものは変えない（印を付けるだけ）。
 * 末尾の改行のあとに空のレコードは作らない。
 */
function ParseCsv(text) {
  var records = [];
  var fields = [];
  var field = '';
  var inQuotes = false;
  var line = 1;
  var startLine = 1;
  var quoteLine = 0; // 開いている引用符が始まった行
  var quoteHasNewline = false; // 開いている引用符の中で改行を読んだか
  var quoteTail = null;
  var atFieldStart = true;
  var hasContent = false; // 現在のレコードに 1 文字でも読んだか
  var i = 0;
  var n = text.length;

  function endRecord() {
    fields.push(field);
    records.push({ line: startLine, fields: fields, unclosedQuoteLine: inQuotes ? quoteLine : 0, quoteTail: quoteTail });
    fields = [];
    quoteTail = null;
    field = '';
    atFieldStart = true;
    hasContent = false;
  }

  while (i < n) {
    var ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        if (quoteHasNewline && quoteTail === null && !isQuoteEnd_(text, i + 1)) {
          quoteTail = { startLine: quoteLine, endLine: line, field: fields.length };
        }
        i++; continue;
      }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i += 2; else i++;
        field += '\n';
        line++;
        quoteHasNewline = true;
        continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && atFieldStart) { inQuotes = true; quoteLine = line; quoteHasNewline = false; atFieldStart = false; hasContent = true; i++; continue; }
    if (ch === ',') { fields.push(field); field = ''; atFieldStart = true; hasContent = true; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i += 2; else i++;
      endRecord();
      line++;
      startLine = line;
      continue;
    }
    field += ch; atFieldStart = false; hasContent = true; i++;
  }
  if (hasContent || fields.length > 0 || field !== '') endRecord();
  return records;
}

/** 閉じた引用符の後ろ（pos から）が、空白を読み飛ばして , ・CR・LF・ファイルの終わりのどれかか */
function isQuoteEnd_(text, pos) {
  var j = pos;
  while (j < text.length && isSpaceChar_(text.charAt(j))) j++;
  if (j >= text.length) return true;
  var c = text.charAt(j);
  return c === ',' || c === '\r' || c === '\n';
}

function isSpaceChar_(c) {
  return c === ' ' || c === '\t' || c === '　';
}

/** 文字列の中の文字 ch の数 */
function countChar_(s, ch) {
  var n = 0;
  for (var i = 0; i < s.length; i++) if (s.charAt(i) === ch) n++;
  return n;
}

/** 文の中の {name} をすべて置き換える */
function replaceAll_(s, name, value) {
  return s.split('{' + name + '}').join(String(value));
}

/** 判定 A のエラー文。列名は最後に置き換える（列名の中の { } を置き換えないように） */
function QuoteTailMessage(startLine, endLine, column) {
  var s = replaceAll_(QUOTE_TAIL_MESSAGE, 'startLine', startLine);
  s = replaceAll_(s, 'endLine', endLine);
  return replaceAll_(s, 'column', column);
}

/** 判定 B のエラー文 */
function QuoteCommaMessage(startLine, endLine, column, newlines, commas) {
  var s = replaceAll_(QUOTE_COMMA_MESSAGE, 'startLine', startLine);
  s = replaceAll_(s, 'endLine', endLine);
  s = replaceAll_(s, 'newlines', newlines);
  s = replaceAll_(s, 'commas', commas);
  return replaceAll_(s, 'column', column);
}

/**
 * エラー文に出す列名。見出しの値の最初の改行より前を TrimText したもの。見出しより右か、空なら「N 列目」（N は 1 から）。
 * 改行より前だけにするのは、見出しの行で引用符が始まったとき、見出しの値に後ろの行が吸い込まれているため。
 */
function quoteColumnName_(headerFields, field) {
  var name = field < headerFields.length ? TrimText(String(headerFields[field]).split('\n')[0]) : '';
  return name === '' ? (field + 1) + ' 列目' : name;
}

/**
 * 設定の CSV_FOLDER を整える。前後の空白を除き、全体が "…" で囲まれていれば外側の引用符を除く
 * （Windows の「パスのコピー」は引用符つきでコピーされるため）。
 */
function CleanFolderPath(s) {
  var t = TrimText(s);
  if (t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') t = TrimText(t.slice(1, -1));
  return t;
}

/** 前後の半角スペース・タブ・全角スペースを除く */
function TrimText(s) {
  var str = s === undefined || s === null ? '' : String(s);
  var start = 0;
  var end = str.length;
  while (start < end && isSpaceChar_(str.charAt(start))) start++;
  while (end > start && isSpaceChar_(str.charAt(end - 1))) end--;
  return str.slice(start, end);
}

/** 全角数字・全角マイナスを半角にする */
function toHalfWidthDigits_(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xff10 && c <= 0xff19) out += String.fromCharCode(c - 0xff10 + 48);
    else if (c === 0xff0d || c === 0x2212) out += '-';
    else if (c === 0xff0e) out += '.';
    else out += s.charAt(i);
  }
  return out;
}

/** 数量・金額を数値にする。読めなければ null */
function ParseNumber(s) {
  var t = toHalfWidthDigits_(TrimText(s));
  var removed = '';
  for (var i = 0; i < t.length; i++) {
    var c = t.charAt(i);
    if (',，¥￥\\円 \t　'.indexOf(c) === -1) removed += c;
  }
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(removed)) return null;
  return Number(removed);
}

function isLeapYear_(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth_(y, m) {
  if (m === 2) return isLeapYear_(y) ? 29 : 28;
  return [4, 6, 9, 11].indexOf(m) !== -1 ? 30 : 31;
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** 日付を { ymd: 'YYYY-MM-DD', ym: 'YYYY-MM' } にする。読めなければ null */
function ParseDate(s) {
  var t = toHalfWidthDigits_(TrimText(s));
  var cut = t.length;
  var sp = t.indexOf(' ');
  var tp = t.indexOf('T');
  if (sp !== -1 && sp < cut) cut = sp;
  if (tp !== -1 && tp < cut) cut = tp;
  t = t.slice(0, cut).replace(/年/g, '/').replace(/月/g, '/').replace(/日/g, '');
  var y;
  var m;
  var d;
  var parts;
  if (/^[0-9]{8}$/.test(t)) {
    parts = [t.slice(0, 4), t.slice(4, 6), t.slice(6, 8)];
  } else {
    parts = t.split(/[\/-]/);
    if (parts.length !== 3) return null;
    if (!/^[0-9]{4}$/.test(parts[0]) || !/^[0-9]{1,2}$/.test(parts[1]) || !/^[0-9]{1,2}$/.test(parts[2])) return null;
  }
  y = Number(parts[0]);
  m = Number(parts[1]);
  d = Number(parts[2]);
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth_(y, m)) return null;
  var ym = y + '-' + pad2_(m);
  return { ymd: ym + '-' + pad2_(d), ym: ym };
}

/**
 * 見出しから列の位置（0 から）を探す。見出し名は前後の空白を除いて完全一致。同じ名前が複数あれば最初の列。
 * colNames: { date, product, quantity, amount, orderId }（orderId は空でもよい）
 * 戻り値: { date, product, quantity, amount, orderId（なければ -1）, missing: [見つからない見出し名] }
 */
function FindColumns(headerFields, colNames) {
  var header = headerFields.map(function (h) { return TrimText(StripBom(h)); });
  var find = function (name) { return name ? header.indexOf(name) : -1; };
  var result = {
    date: find(colNames.date),
    product: find(colNames.product),
    quantity: find(colNames.quantity),
    amount: find(colNames.amount),
    orderId: find(colNames.orderId),
    missing: [],
  };
  ['date', 'product', 'quantity', 'amount', 'orderId'].forEach(function (key) {
    if (key === 'orderId' && !colNames.orderId) return;
    if (result[key] === -1) result.missing.push(colNames[key]);
  });
  return result;
}

function numberError_(colName, raw) {
  return TrimText(raw) === '' ? '「' + colName + '」が空です' : '「' + colName + '」を数値として読めません: ' + TrimText(raw);
}

function isBlankRecord_(fields) {
  for (var i = 0; i < fields.length; i++) if (TrimText(fields[i]) !== '') return false;
  return true;
}

/**
 * 1 ファイル分のレコード（ParseCsv の結果）を明細にそろえる。
 * quoteCheck: 判定 B（仕様 5.5）を行うか。undefined なら行う（設定 QUOTE_CHECK のない版 3 の設定シートでも検査ありで動くように）。
 * 閉じていない引用符・判定 A・判定 B のどれかに当たったデータのレコードは、引用符のエラーを 1 件だけ出し、
 * 日付・商品・数量・金額のエラーは出さない（データ行には数える）。
 * 見出しのレコードで判定 A・B に当たったら、そのエラーだけを出し、列は探さない（データ行は 0）。
 * エラーは行番号の順に並べて返す。
 * 戻り値: { rows: [{ ym, ymd, orderId, product, quantity, amount, file, line }], errors: [{ file, line, message }], dataRows }
 */
function NormalizeRows(fileName, records, colNames, quoteCheck) {
  if (quoteCheck === undefined) quoteCheck = true;
  var rows = [];
  var errors = [];
  var i = 0;
  var done = function (dataRows) { return { rows: rows, errors: sortErrorsByLine_(errors), dataRows: dataRows }; };
  // 閉じていない引用符があると、そこから後ろの行が 1 つの値に吸い込まれる。黙って行が消えないよう、先にエラーにする
  if (records.length > 0 && records[records.length - 1].unclosedQuoteLine > 0) {
    errors.push({ file: fileName, line: records[records.length - 1].unclosedQuoteLine, message: UNCLOSED_QUOTE_MESSAGE });
  }
  while (i < records.length && isBlankRecord_(records[i].fields)) i++;
  if (i >= records.length) {
    errors.push({ file: fileName, line: 1, message: '見出しの行がありません（空のファイル）' });
    return done(0);
  }
  var headerRec = records[i];
  var headerCount = headerRec.fields.length;
  // 見出しのレコードも判定 A・B の対象にする（audit 3 回目 必須 1）。当たったら見出しが崩れているので、列は探さずに終える。
  // 見出しの閉じていない引用符は上で出しているので、今までどおり列を探す
  if (headerRec.unclosedQuoteLine === 0) {
    if (headerRec.quoteTail) {
      errors.push({ file: fileName, line: headerRec.quoteTail.startLine,
        message: QuoteTailMessage(headerRec.quoteTail.startLine, headerRec.quoteTail.endLine, quoteColumnName_(headerRec.fields, headerRec.quoteTail.field)) });
      return done(0);
    }
    if (quoteCheck && checkQuoteCommas_(fileName, headerRec, headerRec.fields, headerCount, errors)) return done(0);
  }
  var cols = FindColumns(headerRec.fields, colNames);
  if (cols.missing.length > 0) {
    cols.missing.forEach(function (name) {
      var message = '必要な列「' + name + '」が見出しにありません';
      if (name === colNames.orderId) message += '（注文番号の列がない CSV なら、設定の COL_ORDER_ID を空にしてください）';
      errors.push({ file: fileName, line: headerRec.line, message: message });
    });
    return done(0);
  }
  var dataRows = 0;
  var get = function (fields, idx) { return idx >= 0 && idx < fields.length ? fields[idx] : ''; };
  for (i = i + 1; i < records.length; i++) {
    var rec = records[i];
    if (isBlankRecord_(rec.fields)) continue;
    dataRows++;
    // 引用符のエラー（優先順: 閉じていない引用符 → 判定 A → 判定 B）。閉じていない引用符のエラーは上で出している
    if (rec.unclosedQuoteLine > 0) continue;
    if (rec.quoteTail) {
      errors.push({ file: fileName, line: rec.quoteTail.startLine,
        message: QuoteTailMessage(rec.quoteTail.startLine, rec.quoteTail.endLine, quoteColumnName_(headerRec.fields, rec.quoteTail.field)) });
      continue;
    }
    if (quoteCheck && checkQuoteCommas_(fileName, rec, headerRec.fields, headerCount, errors)) continue;
    var before = errors.length;
    var add = function (msg) { errors.push({ file: fileName, line: rec.line, message: msg }); };
    var rawDate = get(rec.fields, cols.date);
    var date = ParseDate(rawDate);
    if (!date) add(TrimText(rawDate) === '' ? '「' + colNames.date + '」が空です' : '「' + colNames.date + '」を日付として読めません: ' + TrimText(rawDate));
    var product = TrimText(get(rec.fields, cols.product));
    if (product === '') add('「' + colNames.product + '」が空です');
    var rawQty = get(rec.fields, cols.quantity);
    var quantity = ParseNumber(rawQty);
    if (quantity === null) add(numberError_(colNames.quantity, rawQty));
    var rawAmount = get(rec.fields, cols.amount);
    var amount = ParseNumber(rawAmount);
    if (amount === null) add(numberError_(colNames.amount, rawAmount));
    if (errors.length > before) continue;
    rows.push({
      ym: date.ym,
      ymd: date.ymd,
      orderId: cols.orderId >= 0 ? TrimText(get(rec.fields, cols.orderId)) : '',
      product: product,
      quantity: quantity,
      amount: amount,
      file: fileName,
      line: rec.line,
    });
  }
  return done(dataRows);
}

/**
 * 1 ファイル分のエラーを行番号の順に並べる（テスト 3 回目 気づいたこと 1）。同じ行のエラーは出した順のまま（挿入ソートで安定）。
 * 閉じていない引用符のエラーは、後ろの行のものでも先に出しているため。
 */
function sortErrorsByLine_(errors) {
  for (var k = 1; k < errors.length; k++) {
    var entry = errors[k];
    var j = k - 1;
    while (j >= 0 && errors[j].line > entry.line) {
      errors[j + 1] = errors[j];
      j--;
    }
    errors[j + 1] = entry;
  }
  return errors;
}

/**
 * 判定 B: 改行を含む値の中のカンマの合計が「見出しの列数 − 1」以上なら、一番左の 1 つでエラーを足して true を返す。
 * 行番号は元のファイルの行に戻す（その値より前の列の改行の数を足す）。
 */
function checkQuoteCommas_(fileName, rec, headerFields, headerCount, errors) {
  var newlinesBefore = 0;
  for (var k = 0; k < rec.fields.length; k++) {
    var value = rec.fields[k];
    var newlines = countChar_(value, '\n');
    if (newlines > 0) {
      var commas = countChar_(value, ',');
      if (commas >= headerCount - 1) {
        var startLine = rec.line + newlinesBefore;
        errors.push({ file: fileName, line: startLine,
          message: QuoteCommaMessage(startLine, startLine + newlines, quoteColumnName_(headerFields, k), newlines, commas) });
        return true;
      }
    }
    newlinesBefore += newlines;
  }
  return false;
}

function dedupeKey_(r) {
  return [r.ymd, r.orderId, r.product, String(r.quantity), String(r.amount)].join('\u0001');
}

/**
 * 重複の削除。rows はファイル名の昇順・行の順に並んでいること。
 * 同じキーの行が複数のファイルにあるときは、ファイルごとの件数のうち最大の数だけ残す。
 * 戻り値: { rows: 残した行, removedByFile: { ファイル名: 除いた行数 } }
 */
function DedupeRecords(rows) {
  var kept = {};
  var inFile = {};
  var currentFile = null;
  var out = [];
  var removedByFile = {};
  rows.forEach(function (r) {
    if (r.file !== currentFile) { currentFile = r.file; inFile = {}; }
    var key = dedupeKey_(r);
    inFile[key] = (inFile[key] || 0) + 1;
    if (inFile[key] > (kept[key] || 0)) {
      kept[key] = inFile[key];
      out.push(r);
    } else {
      removedByFile[r.file] = (removedByFile[r.file] || 0) + 1;
    }
  });
  return { rows: out, removedByFile: removedByFile };
}

/** 文字コード順（UTF-16 のコード単位。VBA の StrComp(…, vbBinaryCompare) と同じ）で比べる */
function compareBinary_(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 「年月 × 商品」で集計。並び順: 年月の昇順 → 金額の降順 → 商品名 */
function AggregateByMonthProduct(rows) {
  var map = {};
  var list = [];
  rows.forEach(function (r) {
    var key = r.ym + '\u0001' + r.product;
    if (!map[key]) {
      map[key] = { ym: r.ym, product: r.product, quantity: 0, amount: 0 };
      list.push(map[key]);
    }
    map[key].quantity += r.quantity;
    map[key].amount += r.amount;
  });
  return list.sort(function (a, b) {
    return compareBinary_(a.ym, b.ym) || (b.amount - a.amount) || compareBinary_(a.product, b.product);
  });
}

/** 「年月」で集計。並び順: 年月の昇順 */
function AggregateByMonth(rows) {
  var map = {};
  var list = [];
  rows.forEach(function (r) {
    if (!map[r.ym]) {
      map[r.ym] = { ym: r.ym, quantity: 0, amount: 0 };
      list.push(map[r.ym]);
    }
    map[r.ym].quantity += r.quantity;
    map[r.ym].amount += r.amount;
  });
  return list.sort(function (a, b) { return compareBinary_(a.ym, b.ym); });
}

/** フォルダ内のファイル名から、読む CSV を選んで並べる（拡張子は大文字・小文字を区別しない。~$ で始まるものは除く） */
function ListCsvFiles(names) {
  return names
    .filter(function (name) {
      return name.length > 4 && name.slice(-4).toLowerCase() === '.csv' && name.slice(0, 2) !== '~$';
    })
    .sort(compareBinary_);
}

/**
 * 全体の流れ（参照実装）。VBA の RunAggregation と同じ順番で処理する。
 * files: [{ name, bytes }]（bytes は Uint8Array）
 * settings: { encoding: '自動' | 'UTF-8' | 'Shift_JIS', dedupe: true/false, quoteCheck: true/false（省略時 true）, colNames: {...} }
 * decode: (bytes, encodingName) => 文字列（Node.js では TextDecoder、VBA では ADODB.Stream）
 * 戻り値: 不備があれば { errors, reports }、明細が 0 行なら { errors: [], reports, noData: true }、
 *         それ以外は { errors: [], reports, details, summary, monthly }
 */
function AggregateFiles(files, settings, decode) {
  var names = ListCsvFiles(files.map(function (f) { return f.name; }));
  var byName = {};
  files.forEach(function (f) { byName[f.name] = f; });
  var allRows = [];
  var errors = [];
  var reports = [];
  names.forEach(function (name) {
    var bytes = byName[name].bytes;
    if (HasUtf16Bom(bytes)) {
      errors.push({ file: name, line: 1, message: UTF16_MESSAGE });
      reports.push({ file: name, encoding: ENCODING_UTF16, dataRows: 0, usedRows: 0, removed: 0 });
      return;
    }
    var enc = settings.encoding === ENCODING_UTF8 ? ENCODING_UTF8
      : settings.encoding === ENCODING_SJIS ? ENCODING_SJIS
      : DetectEncoding(bytes);
    var text = StripBom(decode(bytes, enc === ENCODING_SJIS ? ENCODING_SJIS : ENCODING_UTF8));
    var result = NormalizeRows(name, ParseCsv(text), settings.colNames, settings.quoteCheck);
    result.errors.forEach(function (e) { errors.push(e); });
    result.rows.forEach(function (r) { allRows.push(r); });
    reports.push({ file: name, encoding: enc, dataRows: result.dataRows, usedRows: result.rows.length, removed: 0 });
  });
  var details = allRows;
  if (settings.dedupe) {
    var d = DedupeRecords(allRows);
    details = d.rows;
    reports.forEach(function (rep) {
      var removed = d.removedByFile[rep.file] || 0;
      rep.removed = removed;
      rep.usedRows -= removed;
    });
  }
  if (details.length > MAX_DETAIL_ROWS) {
    errors.push({ file: '（全体）', line: 0, message: '明細が ' + details.length + ' 行あり、シートの上限（' + MAX_DETAIL_ROWS + ' 行）を超えています' });
  }
  if (errors.length > 0) return { errors: errors, reports: reports };
  // どの CSV も見出しだけ（データ 0 行）なら、空の集計は作らずに知らせる
  if (details.length === 0) return { errors: [], reports: reports, noData: true };
  return {
    errors: [],
    reports: reports,
    details: details,
    summary: AggregateByMonthProduct(details),
    monthly: AggregateByMonth(details),
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    ENCODING_UTF8_BOM: ENCODING_UTF8_BOM,
    ENCODING_UTF8: ENCODING_UTF8,
    ENCODING_SJIS: ENCODING_SJIS,
    ENCODING_UTF16: ENCODING_UTF16,
    UNCLOSED_QUOTE_MESSAGE: UNCLOSED_QUOTE_MESSAGE,
    UTF16_MESSAGE: UTF16_MESSAGE,
    QUOTE_TAIL_MESSAGE: QUOTE_TAIL_MESSAGE,
    QUOTE_COMMA_MESSAGE: QUOTE_COMMA_MESSAGE,
    QuoteTailMessage: QuoteTailMessage,
    QuoteCommaMessage: QuoteCommaMessage,
    MAX_DETAIL_ROWS: MAX_DETAIL_ROWS,
    IsValidUtf8: IsValidUtf8,
    HasUtf16Bom: HasUtf16Bom,
    DetectEncoding: DetectEncoding,
    StripBom: StripBom,
    ParseCsv: ParseCsv,
    CleanFolderPath: CleanFolderPath,
    TrimText: TrimText,
    ParseNumber: ParseNumber,
    ParseDate: ParseDate,
    FindColumns: FindColumns,
    NormalizeRows: NormalizeRows,
    DedupeRecords: DedupeRecords,
    AggregateByMonthProduct: AggregateByMonthProduct,
    AggregateByMonth: AggregateByMonth,
    ListCsvFiles: ListCsvFiles,
    AggregateFiles: AggregateFiles,
  };
}
