const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib.js');

const bytes = (arr) => Uint8Array.from(arr);
const utf8 = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const COLS = { date: '注文日', product: '商品名', quantity: '数量', amount: '金額', orderId: '注文番号' };

// ---------- 文字コード ----------
test('IsValidUtf8: 正しい UTF-8・ASCII・空は true', () => {
  assert.equal(lib.IsValidUtf8(utf8('注文日,商品名')), true);
  assert.equal(lib.IsValidUtf8(utf8('abc,123')), true);
  assert.equal(lib.IsValidUtf8(bytes([])), true);
  assert.equal(lib.IsValidUtf8(utf8('😀')), true); // 4 バイト
});

test('IsValidUtf8: Shift_JIS・途中で切れた列・過長表現・サロゲートは false', () => {
  assert.equal(lib.IsValidUtf8(bytes([0x92, 0x8d, 0x95, 0xb6])), false); // 「注文」の Shift_JIS
  assert.equal(lib.IsValidUtf8(bytes([0xe6, 0xb3])), false); // 3 バイト文字の途中で終わる
  assert.equal(lib.IsValidUtf8(bytes([0xc0, 0xaf])), false); // 過長表現
  assert.equal(lib.IsValidUtf8(bytes([0xe0, 0x80, 0xaf])), false); // 過長表現（3 バイト）
  assert.equal(lib.IsValidUtf8(bytes([0xed, 0xa0, 0x80])), false); // サロゲート U+D800
  assert.equal(lib.IsValidUtf8(bytes([0xf4, 0x90, 0x80, 0x80])), false); // U+110000
  assert.equal(lib.IsValidUtf8(bytes([0x80])), false); // 先頭が継続バイト
});

test('HasUtf16Bom: 先頭が FF FE / FE FF なら true', () => {
  assert.equal(lib.HasUtf16Bom(bytes([0xff, 0xfe, 0x28, 0x6c])), true);
  assert.equal(lib.HasUtf16Bom(bytes([0xfe, 0xff, 0x6c, 0x28])), true);
  assert.equal(lib.HasUtf16Bom(bytes([0xef, 0xbb, 0xbf, 0x61])), false);
  assert.equal(lib.HasUtf16Bom(bytes([0xff])), false);
  assert.equal(lib.HasUtf16Bom(bytes([])), false);
});

test('DetectEncoding: BOM → UTF-8 → Shift_JIS の順に判定する', () => {
  assert.equal(lib.DetectEncoding(bytes([0xef, 0xbb, 0xbf, 0x61])), lib.ENCODING_UTF8_BOM);
  assert.equal(lib.DetectEncoding(utf8('注文日')), lib.ENCODING_UTF8);
  assert.equal(lib.DetectEncoding(utf8('date,qty')), lib.ENCODING_UTF8); // ASCII だけ
  assert.equal(lib.DetectEncoding(bytes([0x92, 0x8d, 0x95, 0xb6, 0x93, 0xfa])), lib.ENCODING_SJIS);
  assert.equal(lib.DetectEncoding(bytes([0xef, 0xbb])), lib.ENCODING_SJIS); // BOM の途中で終わる
});

test('StripBom: 先頭の U+FEFF を 1 つだけ除く', () => {
  assert.equal(lib.StripBom('﻿注文日'), '注文日');
  assert.equal(lib.StripBom('﻿﻿a'), '﻿a');
  assert.equal(lib.StripBom(''), '');
  assert.equal(lib.StripBom('a﻿'), 'a﻿');
});

// ---------- CSV の分解 ----------
const fieldsOf = (text) => lib.ParseCsv(text).map((r) => r.fields);
const linesOf = (text) => lib.ParseCsv(text).map((r) => r.line);

test('ParseCsv: CRLF・LF・CR のどれでも行を分ける。末尾の改行で空の行を作らない', () => {
  const expected = [['a', 'b'], ['1', '2']];
  assert.deepEqual(fieldsOf('a,b\r\n1,2\r\n'), expected);
  assert.deepEqual(fieldsOf('a,b\n1,2\n'), expected);
  assert.deepEqual(fieldsOf('a,b\r1,2\r'), expected);
  assert.deepEqual(fieldsOf('a,b\r\n1,2'), expected); // 末尾の改行なし
  assert.deepEqual(fieldsOf(''), []);
});

test('ParseCsv: 引用符の中のカンマ・改行・"" を値として扱う', () => {
  assert.deepEqual(fieldsOf('"1,960","a""b","x\ny"\r\n'), [['1,960', 'a"b', 'x\ny']]);
  assert.deepEqual(fieldsOf('"",x\n'), [['', 'x']]);
});

test('ParseCsv: 引用符の中の改行は、CRLF・LF・CR のどれでも LF にそろえる', () => {
  assert.deepEqual(fieldsOf('"x\r\ny",1\r\n'), [['x\ny', '1']]);
  assert.deepEqual(fieldsOf('"x\ny",1\n'), [['x\ny', '1']]);
  assert.deepEqual(fieldsOf('"x\ry",1\r'), [['x\ny', '1']]);
  assert.deepEqual(fieldsOf('"a\r\n\r\nb"\r\n'), [['a\n\nb']]);
  assert.deepEqual(linesOf('"a\r\nb",1\r\nc,2\r\n'), [1, 3]); // 行番号は物理的な行のまま
});

test('ParseCsv: 空の項目・末尾のカンマ・空行', () => {
  assert.deepEqual(fieldsOf('a,,c,\n\n1,2,3,4\n'), [['a', '', 'c', ''], [''], ['1', '2', '3', '4']]);
});

test('ParseCsv: 行番号は、そのレコードが始まる物理的な行', () => {
  assert.deepEqual(linesOf('h\n"a\nb\nc"\nx\r\n\r\ny'), [1, 2, 5, 6, 7]);
});

test('ParseCsv: 閉じていない引用符は、ファイルの終わりまでを 1 つの値にし（落ちない）、引用符が始まった行を返す', () => {
  const recs = lib.ParseCsv('h\na,"bc\nd\ne');
  assert.deepEqual(recs.map((r) => r.fields), [['h'], ['a', 'bc\nd\ne']]);
  assert.deepEqual(recs.map((r) => r.unclosedQuoteLine), [0, 2]);
  // 閉じた引用符（中に改行あり）のあとで、次の値の引用符が閉じていない
  assert.deepEqual(lib.ParseCsv('"x\ny","z\n').map((r) => r.unclosedQuoteLine), [2]);
});

test('ParseCsv: 引用符がすべて閉じていれば unclosedQuoteLine は 0', () => {
  assert.deepEqual(lib.ParseCsv('a,"b\nc"\nd,""\n').map((r) => r.unclosedQuoteLine), [0, 0]);
});

test('ParseCsv: 引用符の途中から始まる値は、そのまま文字として読む', () => {
  assert.deepEqual(fieldsOf('ab"c,"d"e\n'), [['ab"c', 'de']]);
});

// ---------- 値の解釈 ----------
test('CleanFolderPath: 前後の空白と、全体を囲む二重引用符を除く', () => {
  assert.equal(lib.CleanFolderPath('"C:\\Users\\me\\csv"'), 'C:\\Users\\me\\csv'); // エクスプローラーの「パスのコピー」
  assert.equal(lib.CleanFolderPath('  " C:\\csv "　'), 'C:\\csv');
  assert.equal(lib.CleanFolderPath('C:\\csv'), 'C:\\csv');
  assert.equal(lib.CleanFolderPath('"'), '"'); // 1 文字だけなら囲みではない
  assert.equal(lib.CleanFolderPath('""'), '');
  assert.equal(lib.CleanFolderPath('"C:\\csv'), '"C:\\csv'); // 片方だけなら除かない
  assert.equal(lib.CleanFolderPath(''), '');
});

test('TrimText: 半角スペース・タブ・全角スペースを前後から除く', () => {
  assert.equal(lib.TrimText(' \t　商品 A　 '), '商品 A');
  assert.equal(lib.TrimText(''), '');
  assert.equal(lib.TrimText(undefined), '');
  assert.equal(lib.TrimText('　'), '');
});

test('ParseNumber: 桁区切り・円記号・全角数字・マイナス・小数を読む', () => {
  assert.equal(lib.ParseNumber('1,960'), 1960);
  assert.equal(lib.ParseNumber('¥1,960'), 1960);
  assert.equal(lib.ParseNumber('￥1,960'), 1960);
  assert.equal(lib.ParseNumber('\\1,960'), 1960); // Shift_JIS の 0x5C
  assert.equal(lib.ParseNumber('1,960円'), 1960);
  assert.equal(lib.ParseNumber('１９６０'), 1960);
  assert.equal(lib.ParseNumber('－５００'), -500);
  assert.equal(lib.ParseNumber('-500'), -500);
  assert.equal(lib.ParseNumber('1.5'), 1.5);
  assert.equal(lib.ParseNumber(' 0012 '), 12);
  assert.equal(lib.ParseNumber('0'), 0);
});

test('ParseNumber: 空・文字・記号だけ・指数表記・小数点の位置がおかしいものは null', () => {
  for (const s of ['', '   ', 'abc', '-', '.5', '5.', '1.2.3', '1e3', '+5', '12a', '--1', 'NaN', 'Infinity']) {
    assert.equal(lib.ParseNumber(s), null, s);
  }
});

test('ParseDate: よくある書き方を読む', () => {
  const ok = {
    '2026/9/1': '2026-09-01',
    '2026-09-01': '2026-09-01',
    '2026/09/01 12:34': '2026-09-01',
    '2026-09-01T12:34:56+09:00': '2026-09-01',
    '20260901': '2026-09-01',
    '2026年9月1日': '2026-09-01',
    '２０２６/０９/０１': '2026-09-01',
    ' 2026/12/31 ': '2026-12-31',
    '2024/02/29': '2024-02-29',
    '2000/02/29': '2000-02-29',
  };
  for (const [input, ymd] of Object.entries(ok)) {
    assert.deepEqual(lib.ParseDate(input), { ymd, ym: ymd.slice(0, 7) }, input);
  }
});

test('ParseDate: ありえない日付・形の違うものは null', () => {
  for (const s of ['', '2026/02/29', '1900/02/29', '2026/13/01', '2026/00/10', '2026/04/31', '2026/1/0', '26/09/01', '2026/09', '09/01/2026', '2026/09/01/02', 'abc', '2026/9/001', '1899/12/31', '202609011']) {
    assert.equal(lib.ParseDate(s), null, s);
  }
});

// ---------- 見出しと明細 ----------
test('FindColumns: 見出し名で探す（順番違い・余分な列・前後の空白・BOM つき）', () => {
  const r = lib.FindColumns(['﻿注文日', '備考', ' 金額 ', '数量', '商品名', '注文番号'], COLS);
  assert.deepEqual(r, { date: 0, product: 4, quantity: 3, amount: 2, orderId: 5, missing: [] });
});

test('FindColumns: 必須の列がなければ missing に入る。注文番号は設定が空なら探さない', () => {
  const r = lib.FindColumns(['注文日', '商品名'], COLS);
  assert.deepEqual(r.missing, ['数量', '金額', '注文番号']);
  const r2 = lib.FindColumns(['注文日', '商品名', '数量', '金額'], Object.assign({}, COLS, { orderId: '' }));
  assert.deepEqual(r2.missing, []);
  assert.equal(r2.orderId, -1);
});

test('FindColumns: 同じ見出しが 2 つあれば最初の列を使う', () => {
  assert.equal(lib.FindColumns(['金額', '金額', '注文日', '商品名', '数量'], Object.assign({}, COLS, { orderId: '' })).amount, 0);
});

test('NormalizeRows: 見出しの前の空行・空行を読み飛ばし、行番号を正しく付ける', () => {
  const recs = lib.ParseCsv('\r\n注文番号,注文日,商品名,数量,金額\r\nA-1,2026/10/01,コーヒー,1,500\r\n,,,,\r\nA-2,2026/10/02,紅茶,2,"1,000"\r\n');
  const r = lib.NormalizeRows('t.csv', recs, COLS);
  assert.deepEqual(r.errors, []);
  assert.equal(r.dataRows, 2);
  assert.deepEqual(r.rows.map((x) => [x.line, x.orderId, x.product, x.amount]), [[3, 'A-1', 'コーヒー', 500], [5, 'A-2', '紅茶', 1000]]);
});

test('NormalizeRows: 列の少ない行は、足りない値を空として扱いエラーにする', () => {
  const recs = lib.ParseCsv('注文番号,注文日,商品名,数量,金額\nA-1,2026/10/01,コーヒー\n');
  const r = lib.NormalizeRows('t.csv', recs, COLS);
  assert.deepEqual(r.errors.map((e) => e.message), ['「数量」が空です', '「金額」が空です']);
  assert.equal(r.rows.length, 0);
});

test('NormalizeRows: 注文番号の列がないときは、設定を空にするよう案内する', () => {
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv('注文日,商品名,数量,金額\n2026/10/01,X,1,1\n'), COLS);
  assert.deepEqual(r.errors.map((e) => e.message), ['必要な列「注文番号」が見出しにありません（注文番号の列がない CSV なら、設定の COL_ORDER_ID を空にしてください）']);
});

test('NormalizeRows: 見出しだけのファイルは、エラーなし・明細 0 行', () => {
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv('注文番号,注文日,商品名,数量,金額\r\n'), COLS);
  assert.deepEqual(r, { rows: [], errors: [], dataRows: 0 });
});

test('NormalizeRows: 使わない列（備考）の閉じていない引用符は、引用符が始まった行番号つきのエラーにする', () => {
  // 修正前は、後ろの 2 行が備考の値に吸い込まれ、エラーなしで明細が 1 行になっていた
  const text = '注文日,商品名,数量,金額,備考\r\n2026/10/01,X,1,100,"至急\r\n2026/10/02,Y,1,200,\r\n2026/10/03,Z,1,300,\r\n';
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv(text), Object.assign({}, COLS, { orderId: '' }));
  assert.deepEqual(r.errors, [{ file: 't.csv', line: 2, message: lib.UNCLOSED_QUOTE_MESSAGE }]);
});

test('NormalizeRows: 見出しの中の閉じていない引用符もエラーにする（見出しが見つからないエラーと一緒に出す）', () => {
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv('注文日,"商品名,数量,金額\n2026/10/01,X,1,100\n'), Object.assign({}, COLS, { orderId: '' }));
  assert.equal(r.errors[0].message, lib.UNCLOSED_QUOTE_MESSAGE);
  assert.equal(r.errors[0].line, 1);
  assert.ok(r.errors.length > 1);
});

test('NormalizeRows: 空白だけのファイルは「見出しの行がありません」', () => {
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv('\r\n \r\n'), COLS);
  assert.deepEqual(r.errors, [{ file: 't.csv', line: 1, message: '見出しの行がありません（空のファイル）' }]);
});

// ---------- 重複の削除 ----------
const row = (file, line, orderId, product, qty, amount, ymd = '2026-10-01') => ({ ym: ymd.slice(0, 7), ymd, orderId, product, quantity: qty, amount, file, line });

test('DedupeRecords: ファイルをまたぐ同じ行は 1 回だけ数える', () => {
  const r = lib.DedupeRecords([row('a', 2, 'A-1', 'X', 1, 100), row('b', 2, 'A-1', 'X', 1, 100)]);
  assert.deepEqual(r.rows.map((x) => x.file), ['a']);
  assert.deepEqual(r.removedByFile, { b: 1 });
});

test('DedupeRecords: 1 つのファイル内の同じ行は消さない（ファイルごとの件数の最大を残す）', () => {
  const r = lib.DedupeRecords([
    row('a', 2, 'A-1', 'X', 1, 100), row('a', 3, 'A-1', 'X', 1, 100), // a に 2 件
    row('b', 2, 'A-1', 'X', 1, 100), // b に 1 件 → 除く
    row('c', 2, 'A-1', 'X', 1, 100), row('c', 3, 'A-1', 'X', 1, 100), row('c', 4, 'A-1', 'X', 1, 100), // c に 3 件 → 1 件だけ増やす
  ]);
  assert.deepEqual(r.rows.map((x) => x.file + x.line), ['a2', 'a3', 'c4']);
  assert.deepEqual(r.removedByFile, { b: 1, c: 2 });
});

test('DedupeRecords: 数量・金額・日付・注文番号のどれかが違えば別の行', () => {
  const r = lib.DedupeRecords([
    row('a', 2, 'A-1', 'X', 1, 100),
    row('b', 2, 'A-1', 'X', 2, 100),
    row('b', 3, 'A-1', 'X', 1, 101),
    row('b', 4, 'A-1', 'X', 1, 100, '2026-10-02'),
    row('b', 5, 'A-2', 'X', 1, 100),
  ]);
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.removedByFile, {});
});

// ---------- 集計 ----------
test('AggregateByMonthProduct: 年月の昇順 → 金額の降順 → 商品名の順', () => {
  const rows = [
    row('a', 2, '', 'B', 1, 100, '2026-10-05'),
    row('a', 3, '', 'A', 2, 100, '2026-10-06'),
    row('a', 4, '', 'C', 1, 500, '2026-10-07'),
    row('a', 5, '', 'B', 1, 50, '2026-09-30'),
    row('a', 6, '', 'B', 3, 300, '2026-10-08'),
  ];
  assert.deepEqual(lib.AggregateByMonthProduct(rows), [
    { ym: '2026-09', product: 'B', quantity: 1, amount: 50 },
    { ym: '2026-10', product: 'C', quantity: 1, amount: 500 },
    { ym: '2026-10', product: 'B', quantity: 4, amount: 400 },
    { ym: '2026-10', product: 'A', quantity: 2, amount: 100 },
  ]);
});

test('AggregateByMonth: 年またぎも年月の昇順', () => {
  const rows = [row('a', 2, '', 'X', 1, 100, '2027-01-01'), row('a', 3, '', 'X', 1, 200, '2026-12-31'), row('a', 4, '', 'X', 2, 50, '2027-01-15')];
  assert.deepEqual(lib.AggregateByMonth(rows), [
    { ym: '2026-12', quantity: 1, amount: 200 },
    { ym: '2027-01', quantity: 3, amount: 150 },
  ]);
});

test('AggregateByMonthProduct / AggregateByMonth: 明細 0 行なら空', () => {
  assert.deepEqual(lib.AggregateByMonthProduct([]), []);
  assert.deepEqual(lib.AggregateByMonth([]), []);
});

// ---------- ファイル一覧と全体 ----------
test('ListCsvFiles: .csv だけを選び（大文字も可）、~$ の一時ファイルを除き、名前順に並べる', () => {
  assert.deepEqual(
    lib.ListCsvFiles(['b.csv', 'a.CSV', '~$a.csv', 'memo.txt', 'c.csv.bak', '.csv', 'B.csv', 'a-1.csv']),
    ['B.csv', 'a-1.csv', 'a.CSV', 'b.csv'],
  );
  assert.deepEqual(lib.ListCsvFiles([]), []);
});

const utf8Decode = (b) => Buffer.from(b).toString('utf8');
const HEADER = '注文番号,注文日,商品名,数量,金額\n';

test('AggregateFiles: UTF-16 の BOM で始まるファイルは、文字コードが原因と分かるエラーにする（ENCODING を固定していても）', () => {
  const le = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(HEADER + 'A,2026/10/01,X,1,1\n', 'utf16le')]));
  const ok = { name: 'b.csv', bytes: utf8(HEADER + 'B,2026/10/01,Y,1,1\n') };
  for (const encoding of ['自動', 'UTF-8', 'Shift_JIS']) {
    const r = lib.AggregateFiles([{ name: 'a.csv', bytes: le }, ok], { encoding, dedupe: true, colNames: COLS }, utf8Decode);
    assert.deepEqual(r.errors, [{ file: 'a.csv', line: 1, message: lib.UTF16_MESSAGE }], encoding);
    assert.equal(r.reports[0].encoding, lib.ENCODING_UTF16);
    assert.equal(r.summary, undefined);
  }
  const be = bytes([0xfe, 0xff, 0x6c, 0xe8]);
  assert.deepEqual(lib.AggregateFiles([{ name: 'c.csv', bytes: be }], { encoding: '自動', dedupe: true, colNames: COLS }, utf8Decode).errors.map((e) => e.message), [lib.UTF16_MESSAGE]);
});

test('AggregateFiles: どの CSV も見出しだけ（データ 0 行）なら、集計を作らず noData を返す', () => {
  const files = [{ name: 'a.csv', bytes: utf8(HEADER) }, { name: 'b.csv', bytes: utf8(HEADER + '\n') }];
  const r = lib.AggregateFiles(files, { encoding: '自動', dedupe: true, colNames: COLS }, utf8Decode);
  assert.deepEqual(r.errors, []);
  assert.equal(r.noData, true);
  assert.equal(r.summary, undefined);
  assert.equal(r.reports.length, 2);
});

test('AggregateFiles: 1 つでもデータがあれば noData にならない', () => {
  const files = [{ name: 'a.csv', bytes: utf8(HEADER) }, { name: 'b.csv', bytes: utf8(HEADER + 'B,2026/10/01,Y,1,1\n') }];
  const r = lib.AggregateFiles(files, { encoding: '自動', dedupe: true, colNames: COLS }, utf8Decode);
  assert.equal(r.noData, undefined);
  assert.equal(r.details.length, 1);
});

test('AggregateFiles: 明細がシートの上限を超えたらエラーにする', () => {
  const header = '注文番号,注文日,商品名,数量,金額\n';
  // 上限ちょうど + 1 行を、同じ内容の行で作る（DEDUPE を OFF にして重複を残す）
  const body = 'A,2026/10/01,X,1,1\n'.repeat(lib.MAX_DETAIL_ROWS + 1);
  const files = [{ name: 'big.csv', bytes: utf8(header + body) }];
  const decode = (b) => Buffer.from(b).toString('utf8');
  const r = lib.AggregateFiles(files, { encoding: '自動', dedupe: false, colNames: COLS }, decode);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /上限/);
});

// ---------- 2 回目の audit の修正を壊す使い方（tester 追加） ----------
const NO_ID = Object.assign({}, COLS, { orderId: '' });
const HEADER4 = '注文日,商品名,数量,金額\n';
const settingsOf = (encoding = '自動', dedupe = true, colNames = NO_ID) => ({ encoding, dedupe, colNames });

test('ParseCsv: 閉じていない引用符の端のケース（引用符 1 文字だけ・最後の値・"" で終わる・引用符と改行で終わる）', () => {
  assert.deepEqual(lib.ParseCsv('"'), [{ line: 1, fields: [''], unclosedQuoteLine: 1, quoteTail: null }]);
  assert.deepEqual(lib.ParseCsv('a,"'), [{ line: 1, fields: ['a', ''], unclosedQuoteLine: 1, quoteTail: null }]);
  // "a"" は「a と、エスケープされた "」で、まだ閉じていない
  assert.deepEqual(lib.ParseCsv('"a""'), [{ line: 1, fields: ['a"'], unclosedQuoteLine: 1, quoteTail: null }]);
  // "abc""" は閉じている
  assert.deepEqual(lib.ParseCsv('"abc"""\n'), [{ line: 1, fields: ['abc"'], unclosedQuoteLine: 0, quoteTail: null }]);
  // 最後の行で引用符が開き、改行で終わる
  assert.deepEqual(lib.ParseCsv('h\nx,"\n').map((r) => r.unclosedQuoteLine), [0, 2]);
  // 引用符の中の CR で終わる
  assert.deepEqual(lib.ParseCsv('"a\r'), [{ line: 1, fields: ['a\n'], unclosedQuoteLine: 1, quoteTail: null }]);
});

test('ParseCsv: 閉じていない引用符の行番号は、CR だけ・混在した改行でも物理的な行になる', () => {
  assert.deepEqual(lib.ParseCsv('h\r"x\ry\r'), [
    { line: 1, fields: ['h'], unclosedQuoteLine: 0, quoteTail: null },
    { line: 2, fields: ['x\ny\n'], unclosedQuoteLine: 2, quoteTail: null },
  ]);
  assert.deepEqual(lib.ParseCsv('h\r\n1\n2\r"x\ry\nz\r\nw'), [
    { line: 1, fields: ['h'], unclosedQuoteLine: 0, quoteTail: null },
    { line: 2, fields: ['1'], unclosedQuoteLine: 0, quoteTail: null },
    { line: 3, fields: ['2'], unclosedQuoteLine: 0, quoteTail: null },
    { line: 4, fields: ['x\ny\nz\nw'], unclosedQuoteLine: 4, quoteTail: null },
  ]);
});

test('ParseCsv: 1 つの値の中に CR・LF・CRLF が混ざっても、すべて LF にそろえ、次の行番号がずれない', () => {
  const recs = lib.ParseCsv('"a\rb\nc\r\nd",1\r\ne,2\n');
  assert.deepEqual(recs.map((r) => r.fields), [['a\nb\nc\nd', '1'], ['e', '2']]);
  assert.deepEqual(recs.map((r) => r.line), [1, 5]);
  // CR の直後に閉じる引用符が来る（CR と LF が引用符をはさんで分かれる）
  assert.deepEqual(lib.ParseCsv('"a\r"\nb\n').map((r) => r.fields), [['a\n'], ['b']]);
  assert.deepEqual(lib.ParseCsv('"a\r"\nb\n').map((r) => r.line), [1, 3]);
  // 空行が引用符の中にある（CR CR、LF LF）
  assert.deepEqual(fieldsOf('"a\r\rb"\n"c\n\nd"\n'), [['a\n\nb'], ['c\n\nd']]);
});

test('ParseCsv: 改行コードだけが違う 2 つのファイルは、値も行番号も同じになる', () => {
  const lf = 'h1,h2\n"x\ny",1\n"p\n\nq",2\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const cr = lf.replace(/\n/g, '\r');
  assert.deepEqual(lib.ParseCsv(crlf), lib.ParseCsv(lf));
  assert.deepEqual(lib.ParseCsv(cr), lib.ParseCsv(lf));
});

test('NormalizeRows: 集計に使う列（商品名）で始まる閉じていない引用符は、その行番号でエラーになり、後ろの行は明細にならない', () => {
  const text = HEADER4 + '2026/10/01,"テスト,1,100\n2026/10/02,Y,1,200\n2026/10/03,Z,1,300\n';
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv(text), NO_ID);
  assert.deepEqual(r.errors[0], { file: 't.csv', line: 2, message: lib.UNCLOSED_QUOTE_MESSAGE });
  assert.deepEqual(r.rows, []);
});

test('NormalizeRows: 最後の行で始まる閉じていない引用符（末尾の改行なし）もエラーにする。手前の正しい行があってもエラーは消えない', () => {
  const text = HEADER4 + '2026/10/01,X,1,100\n2026/10/02,Y,1,"200';
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv(text), NO_ID);
  assert.deepEqual(r.errors[0], { file: 't.csv', line: 3, message: lib.UNCLOSED_QUOTE_MESSAGE });
  // 版 5: 閉じていない引用符のレコード（3 行目）は明細にせず、日付などのエラーも出さない。2 行目だけが明細になる
  assert.deepEqual(r.errors, [{ file: 't.csv', line: 3, message: lib.UNCLOSED_QUOTE_MESSAGE }]);
  assert.deepEqual(r.rows.map((x) => x.line), [2]);
  assert.equal(r.dataRows, 2);
  const all = lib.AggregateFiles([{ name: 't.csv', bytes: utf8(text) }], settingsOf(), utf8Decode);
  assert.deepEqual(all.errors, [{ file: 't.csv', line: 3, message: lib.UNCLOSED_QUOTE_MESSAGE }]);
  assert.equal(all.summary, undefined);
});

test('NormalizeRows: 使わない列の最後の行で始まる閉じていない引用符（中身が空）も、行が消えないようエラーにする', () => {
  const text = '注文日,商品名,数量,金額,備考\r\n2026/10/01,X,1,100,"\r\n';
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv(text), NO_ID);
  assert.deepEqual(r.errors, [{ file: 't.csv', line: 2, message: lib.UNCLOSED_QUOTE_MESSAGE }]);
});

test('NormalizeRows: 空行のあとに引用符 1 文字だけのファイルは、閉じていない引用符と「見出しの行がありません」の両方（行番号の順）', () => {
  const r = lib.NormalizeRows('t.csv', lib.ParseCsv('\n\n"'), NO_ID);
  assert.deepEqual(r.errors.map((e) => [e.line, e.message]), [
    [1, '見出しの行がありません（空のファイル）'],
    [3, lib.UNCLOSED_QUOTE_MESSAGE],
  ]);
});

test('AggregateFiles: 複数のファイルのうち 1 つだけに閉じていない引用符があれば、そのファイルだけエラーにし、集計は作らない', () => {
  const files = [
    { name: 'a.csv', bytes: utf8(HEADER4 + '2026/10/01,A,1,100\n') },
    { name: 'b.csv', bytes: utf8(HEADER4 + '2026/10/02,B,1,200,"メモ\n2026/10/03,B,1,300\n') },
    { name: 'c.csv', bytes: utf8(HEADER4 + '2026/10/04,C,1,400\n') },
  ];
  const r = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  assert.deepEqual(r.errors, [{ file: 'b.csv', line: 2, message: lib.UNCLOSED_QUOTE_MESSAGE }]);
  assert.equal(r.summary, undefined);
  assert.equal(r.details, undefined);
  assert.equal(r.noData, undefined);
  assert.deepEqual(r.reports.map((x) => x.file), ['a.csv', 'b.csv', 'c.csv']);
});

test('AggregateFiles: 見出しの行の閉じていない引用符が 1 ファイルだけにある場合も、集計は作らない', () => {
  const files = [
    { name: 'a.csv', bytes: utf8(HEADER4 + '2026/10/01,A,1,100\n') },
    { name: 'b.csv', bytes: utf8('注文日,"商品名,数量,金額\n2026/10/02,B,1,200\n') },
  ];
  const r = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  assert.equal(r.summary, undefined);
  assert.ok(r.errors.length >= 2);
  assert.ok(r.errors.every((e) => e.file === 'b.csv'));
  assert.deepEqual(r.errors[0], { file: 'b.csv', line: 1, message: lib.UNCLOSED_QUOTE_MESSAGE });
});

test('AggregateFiles: CR だけの改行の Shift_JIS ファイルでも、閉じていない引用符を正しい行番号で返す', () => {
  // 「注文日,商品名,数量,金額」CR「2026/10/01,X,1,100」CR「2026/10/02,"X,1,100」CR「2026/10/03,X,1,100」CR
  const sjis = (s) => {
    const map = { '注': [0x92, 0x8d], '文': [0x95, 0xb6], '日': [0x93, 0xfa], '商': [0x8f, 0xa4], '品': [0x95, 0x69], '名': [0x96, 0xbc], '数': [0x90, 0x94], '量': [0x97, 0xca], '金': [0x8b, 0xe0], '額': [0x8a, 0x7a] };
    const out = [];
    for (const ch of s) { if (map[ch]) out.push(...map[ch]); else out.push(ch.charCodeAt(0)); }
    return Uint8Array.from(out);
  };
  const file = sjis('注文日,商品名,数量,金額\r2026/10/01,X,1,100\r2026/10/02,"X,1,100\r2026/10/03,X,1,100\r');
  const decode = (b, enc) => new TextDecoder(enc === lib.ENCODING_SJIS ? 'shift_jis' : 'utf-8').decode(b);
  const r = lib.AggregateFiles([{ name: 's.csv', bytes: file }], settingsOf(), decode);
  assert.equal(r.reports[0].encoding, lib.ENCODING_SJIS);
  assert.deepEqual(r.errors[0], { file: 's.csv', line: 3, message: lib.UNCLOSED_QUOTE_MESSAGE });
  assert.equal(r.summary, undefined);
});

test('AggregateFiles: 閉じていない引用符のあるファイルは、2 回実行しても同じエラーになり、入力のバイト列を変えない', () => {
  const bytesIn = utf8(HEADER4 + '2026/10/01,X,1,100,"a\n2026/10/02,Y,1,200\n');
  const copy = Uint8Array.from(bytesIn);
  const r1 = lib.AggregateFiles([{ name: 'a.csv', bytes: bytesIn }], settingsOf(), utf8Decode);
  const r2 = lib.AggregateFiles([{ name: 'a.csv', bytes: bytesIn }], settingsOf(), utf8Decode);
  assert.deepEqual(r1, r2);
  assert.deepEqual(bytesIn, copy);
});

test('CleanFolderPath: 片側だけの引用符・空白だけの引用符・空白つき・空・null', () => {
  assert.equal(lib.CleanFolderPath('C:\\csv"'), 'C:\\csv"'); // 後ろだけ
  assert.equal(lib.CleanFolderPath('  "C:\\csv  '), '"C:\\csv'); // 前だけ（前後の空白は除く）
  assert.equal(lib.CleanFolderPath('" "'), ''); // 引用符の中が空白だけ → 空（フォルダの選択画面になる）
  assert.equal(lib.CleanFolderPath('"　\t"'), '');
  assert.equal(lib.CleanFolderPath('\t"C:\\csv"\t'), 'C:\\csv');
  assert.equal(lib.CleanFolderPath('　"C:\\csv"　'), 'C:\\csv');
  assert.equal(lib.CleanFolderPath('"C:\\my folder\\csv"'), 'C:\\my folder\\csv'); // 中の空白は残す
  assert.equal(lib.CleanFolderPath('""C:\\csv""'), '"C:\\csv"'); // 外側の 1 組だけ除く
  assert.equal(lib.CleanFolderPath('   '), '');
  assert.equal(lib.CleanFolderPath(null), '');
  assert.equal(lib.CleanFolderPath(undefined), '');
  // 全角の引用符（“ ”）は除かない（仕様は半角の " だけ）
  assert.equal(lib.CleanFolderPath('“C:\\csv”'), '“C:\\csv”');
});

test('HasUtf16Bom: 2 バイトちょうど・UTF-32 LE の BOM・UTF-8 の BOM・BOM が逆順でないもの', () => {
  assert.equal(lib.HasUtf16Bom(bytes([0xff, 0xfe])), true);
  assert.equal(lib.HasUtf16Bom(bytes([0xfe, 0xff])), true);
  assert.equal(lib.HasUtf16Bom(bytes([0xff, 0xfe, 0x00, 0x00])), true); // UTF-32 LE の BOM も UTF-16 として止める
  assert.equal(lib.HasUtf16Bom(bytes([0xfe])), false);
  assert.equal(lib.HasUtf16Bom(bytes([0xff, 0xff])), false);
  assert.equal(lib.HasUtf16Bom(bytes([0xfe, 0xfe])), false);
  assert.equal(lib.HasUtf16Bom(bytes([0x00, 0xfe, 0xff])), false); // 先頭以外は見ない
});

test('AggregateFiles: 2 バイト未満のファイル（0 バイト・1 バイト）は落ちずにエラーになり、UTF-16 とは言わない', () => {
  for (const b of [[], [0xff], [0xfe], [0x41]]) {
    const r = lib.AggregateFiles([{ name: 'a.csv', bytes: bytes(b) }], settingsOf(), utf8Decode);
    assert.ok(r.errors.length > 0, JSON.stringify(b));
    assert.ok(r.errors.every((e) => e.message !== lib.UTF16_MESSAGE), JSON.stringify(b));
    assert.equal(r.summary, undefined);
  }
  const empty = lib.AggregateFiles([{ name: 'a.csv', bytes: bytes([]) }], settingsOf(), utf8Decode);
  assert.deepEqual(empty.errors, [{ file: 'a.csv', line: 1, message: '見出しの行がありません（空のファイル）' }]);
});

test('AggregateFiles: BOM だけ（FF FE / FE FF の 2 バイト）のファイルも UTF-16 のエラー。UTF-16 BE の本文つきも同じ', () => {
  for (const b of [[0xff, 0xfe], [0xfe, 0xff]]) {
    const r = lib.AggregateFiles([{ name: 'a.csv', bytes: bytes(b) }], settingsOf(), utf8Decode);
    assert.deepEqual(r.errors, [{ file: 'a.csv', line: 1, message: lib.UTF16_MESSAGE }]);
  }
  const le = Buffer.from(HEADER4 + '2026/10/01,X,1,100\n', 'utf16le');
  const be = Buffer.from(le).swap16();
  for (const encoding of ['自動', 'UTF-8', 'Shift_JIS']) {
    const r = lib.AggregateFiles([{ name: 'be.csv', bytes: new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be])) }], settingsOf(encoding), utf8Decode);
    assert.deepEqual(r.errors, [{ file: 'be.csv', line: 1, message: lib.UTF16_MESSAGE }], encoding);
    assert.equal(r.reports[0].encoding, lib.ENCODING_UTF16);
  }
});

test('AggregateFiles: BOM のない UTF-16 は判定できないが、見出しが見つからないエラーになり黙って通らない', () => {
  const le = new Uint8Array(Buffer.from(HEADER4 + '2026/10/01,X,1,100\n', 'utf16le'));
  const r = lib.AggregateFiles([{ name: 'a.csv', bytes: le }], settingsOf(), (b, enc) => new TextDecoder(enc === lib.ENCODING_SJIS ? 'shift_jis' : 'utf-8').decode(b));
  assert.ok(r.errors.length > 0);
  assert.match(r.errors[0].message, /見出しにありません/);
  assert.equal(r.summary, undefined);
});

test('AggregateFiles: UTF-16 のファイルと見出しだけのファイルが混ざると、noData ではなくエラーを返す', () => {
  const files = [
    { name: 'a.csv', bytes: utf8(HEADER4) },
    { name: 'b.csv', bytes: bytes([0xff, 0xfe, 0x41, 0x00]) },
  ];
  const r = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  assert.deepEqual(r.errors.map((e) => e.file), ['b.csv']);
  assert.equal(r.noData, undefined);
});

test('AggregateFiles: 見出しだけのファイルと不備のあるファイルが混ざると、noData ではなくエラーを返す', () => {
  const files = [
    { name: 'a.csv', bytes: utf8(HEADER4) },
    { name: 'b.csv', bytes: utf8(HEADER4 + '2026/13/01,X,1,100\n') },
  ];
  const r = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  assert.equal(r.errors.length, 1);
  assert.equal(r.noData, undefined);
});

test('AggregateFiles: 見出しだけ・データあり・空行だけ（,,, の行）のファイルが混ざると普通に集計し、取り込み結果は 0 行と書く', () => {
  const files = [
    { name: 'a.csv', bytes: utf8(HEADER4) },
    { name: 'b.csv', bytes: utf8(HEADER4 + '2026/10/01,X,2,300\n') },
    { name: 'c.csv', bytes: utf8(HEADER4 + ',,,\r\n , , , \r\n') },
  ];
  const r = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  assert.deepEqual(r.errors, []);
  assert.equal(r.noData, undefined);
  assert.deepEqual(r.summary, [{ ym: '2026-10', product: 'X', quantity: 2, amount: 300 }]);
  assert.deepEqual(r.reports.map((x) => [x.file, x.dataRows, x.usedRows, x.removed]), [['a.csv', 0, 0, 0], ['b.csv', 1, 1, 0], ['c.csv', 0, 0, 0]]);
});

test('AggregateFiles: データ 0 行の判定は DEDUPE の ON/OFF で変わらない。空行だけのファイルも 0 行', () => {
  const files = [{ name: 'a.csv', bytes: utf8(HEADER4 + ',,,\n\n') }, { name: 'b.csv', bytes: utf8('\uFEFF' + HEADER4) }];
  for (const dedupe of [true, false]) {
    const r = lib.AggregateFiles(files, settingsOf('自動', dedupe), utf8Decode);
    assert.deepEqual(r.errors, [], String(dedupe));
    assert.equal(r.noData, true, String(dedupe));
  }
});

test('AggregateFiles: 重複を除いた結果は 0 行にならない（同じ行だけの 2 ファイルでも 1 行残り、noData にならない）', () => {
  const same = utf8(HEADER4 + '2026/10/01,X,1,100\n');
  const r = lib.AggregateFiles([{ name: 'a.csv', bytes: same }, { name: 'b.csv', bytes: same }], settingsOf(), utf8Decode);
  assert.equal(r.noData, undefined);
  assert.equal(r.details.length, 1);
  assert.deepEqual(r.reports.map((x) => x.removed), [0, 1]);
});

// ---------- 5.5 迷子の引用符（仕様 版 5。qa 2 回目 必須 1） ----------
// 期待する文は仕様 5.5 の文言を手で書き写したもの（lib.js の定数から作らない）
const H5 = '注文日,商品名,数量,金額,備考\n';
const tailMsg = (s, e, col) => `${s} 行目の「${col}」で始まった引用符（"）が ${e} 行目で閉じたあと、すぐ後ろに文字が続いています。${s} 行目から ${e} 行目までが 1 つの値として読まれ、行が消えている可能性があります。${s} 行目と ${e} 行目に余分な " がないか確かめてください（値の中に " を書くときは "" と 2 つ重ねます）`;
const commaMsg = (s, e, col, nl, commas) => `${s} 行目の「${col}」で始まった引用符（"）の中に、改行が ${nl} 個とカンマが ${commas} 個あり、1 行分以上のデータが入っているように見えます。${s} 行目から ${e} 行目までが 1 つの値として読まれ、行が消えている可能性があります。${s} 行目と ${e} 行目に余分な " がないか確かめてください。値の中に本当にカンマの多い複数行の文がある場合は、「設定」シートの QUOTE_CHECK を FALSE にしてください`;
const EX1 = H5 + '2026/09/01,商品A,1,100,"至急\n2026/09/02,商品B,1,200,\n2026/09/03,商品C,1,300,\n2026/09/04,商品D,1,400,"再送\n2026/09/05,商品E,1,500,\n';
const EX2 = H5 + '2026/09/01,商品A,1,100,"至急\n2026/09/02,商品B,1,200,\n2026/09/03,商品C,1,300,"\n2026/09/04,商品D,1,400,\n';
const EX3 = HEADER4 + '2026/09/01,"商品A,1,100\n2026/09/02,商品"B,1,200\n';
const EX4 = HEADER4 + '2026/09/01,"商品A,1,100\n2026/09/02,商品B",1,200\n';
const EX5 = H5 + '2026/09/01,商品A,1,100,"至急\n2026/09/02",商品B,1,200,\n';
const EX6 = '注文日,商品名,数量,金額,備考,担当,店舗,区分,メモ\n2026/09/01,商品A,1,100,"至急\n2026/09/02,商品B,1,200\n2026/09/03,商品C,1,300,"\n';
const norm = (text, quoteCheck, cols = NO_ID) => lib.NormalizeRows('t.csv', lib.ParseCsv(text), cols, quoteCheck);
const errs = (r) => r.errors.map((e) => [e.line, e.message]);
const crlfOf = (s) => s.replace(/\n/g, '\r\n');

test('5.5 例 1（判定 A）: 2 行目の備考の " が 5 行目の " で閉じ、後ろに文字が続く → エラー 1 件。QUOTE_CHECK = FALSE でも同じ', () => {
  const recs = lib.ParseCsv(EX1);
  assert.deepEqual(recs[1].quoteTail, { startLine: 2, endLine: 5, field: 4 });
  for (const qc of [true, false, undefined]) {
    const r = norm(EX1, qc);
    assert.deepEqual(errs(r), [[2, tailMsg(2, 5, '備考')]], String(qc));
    assert.equal(r.dataRows, 2);
  }
  // CRLF でも同じ
  assert.deepEqual(errs(norm(crlfOf(EX1), true)), [[2, tailMsg(2, 5, '備考')]]);
});

test('5.5 例 2（判定 B）: 2 つめの " が行末 → 値全体のカンマで当たる。QUOTE_CHECK = FALSE ならエラーなしで明細 2 行（今の動きを固定）', () => {
  assert.equal(lib.ParseCsv(EX2)[1].quoteTail, null);
  // 値は「至急\n2026/09/02,商品B,1,200,\n2026/09/03,商品C,1,300,」で、改行 2 個・カンマ 8 個（4 ＋ 4）
  assert.deepEqual(errs(norm(EX2, true)), [[2, commaMsg(2, 4, '備考', 2, 8)]]);
  assert.deepEqual(errs(norm(crlfOf(EX2), true)), [[2, commaMsg(2, 4, '備考', 2, 8)]]);
  const off = norm(EX2, false);
  assert.deepEqual(off.errors, []);
  assert.deepEqual(off.rows.map((x) => x.line), [2, 5]);
});

test('5.5 例 3（判定 A、真ん中の列・1 行だけ吸い込む）: 列名は「商品名」、2 行目から 3 行目まで', () => {
  assert.deepEqual(lib.ParseCsv(EX3)[1].quoteTail, { startLine: 2, endLine: 3, field: 1 });
  assert.deepEqual(errs(norm(EX3, true)), [[2, tailMsg(2, 3, '商品名')]]);
  assert.deepEqual(errs(norm(crlfOf(EX3), false)), [[2, tailMsg(2, 3, '商品名')]]);
});

test('5.5 例 4（判定 B。版 4 では捕まえられなかった形）: 値のカンマ 3 個 ≥ H − 1 = 3 で当たる。FALSE ならエラーなしで明細 1 行', () => {
  assert.equal(lib.ParseCsv(EX4)[1].quoteTail, null);
  assert.deepEqual(errs(norm(EX4, true)), [[2, commaMsg(2, 3, '商品名', 1, 3)]]);
  assert.deepEqual(errs(norm(crlfOf(EX4), undefined)), [[2, commaMsg(2, 3, '商品名', 1, 3)]]);
  const off = norm(EX4, false);
  assert.deepEqual(off.errors, []);
  assert.equal(off.rows.length, 1);
});

test('5.5 例 5（捕まえられない例。README 9 の制限事項の裏付け）: エラー 0 件、明細 1 行、備考は「至急\\n2026/09/02」', () => {
  const recs = lib.ParseCsv(EX5);
  assert.equal(recs[1].fields[4], '至急\n2026/09/02');
  const r = norm(EX5, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows.map((x) => x.product), ['商品A']);
});

test('5.5 例 5 の間に空の行・空白だけの行がある（捕まえられない例。qa 3 回目 推奨 1。今の動きを固定）: LF・CRLF ともエラー 0 件で 200 の行が消える', () => {
  // 空の行は値にカンマを足さないので、判定 B に届かない
  for (const middle of ['\n', '\n\n', '   \n']) {
    const lf = H5 + '2026/09/01,A,1,100,"至急\n' + middle + '2026/09/02",B,1,200,\n2026/09/03,C,1,300,\n';
    for (const text of [lf, crlfOf(lf)]) {
      const r = norm(text, true);
      assert.deepEqual(r.errors, [], JSON.stringify(text));
      assert.deepEqual(r.rows.map((x) => x.amount), [100, 300], JSON.stringify(text));
    }
  }
  // 閉じた " と , の間に空白があっても同じ（qa 3 回目 任意 7）
  const sp = norm(H5 + '2026/09/01,A,1,100,"至急\n2026/09/02"  ,B,1,200,\n2026/09/03,C,1,300,\n', true);
  assert.deepEqual(sp.errors, []);
  assert.deepEqual(sp.rows.map((x) => x.amount), [100, 300]);
});

test('5.5 例 6（捕まえられない例。後ろの空の列を省く CSV）: カンマ 7 個 < H − 1 = 8 でエラー 0 件、明細 1 行', () => {
  const recs = lib.ParseCsv(EX6);
  assert.equal(recs[1].fields[4], '至急\n2026/09/02,商品B,1,200\n2026/09/03,商品C,1,300,');
  const r = norm(EX6, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 1);
});

test('5.5 エラーにしない正しい CSV: 改行とカンマ 1 個の備考・閉じた後の空白・ファイルの終わり・CR・CRLF・"" を含む値・1 行の中の寛容な読み方', () => {
  const ok = H5 + '2026/09/01,商品A,1,100,"配送メモ\n午前着, 置き配可\n連絡先は別紙"\n';
  assert.equal(lib.ParseCsv(ok)[1].fields[4], '配送メモ\n午前着, 置き配可\n連絡先は別紙');
  for (const text of [ok, crlfOf(ok), ok.replace(/\n/g, '\r')]) {
    const r = norm(text, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.rows.length, 1);
  }
  // 閉じた引用符の後ろに空白（半角・タブ・全角）があってから , や改行
  for (const text of ['"a\nb"  ,1\n', '"a\nb"\t\n', '"a\nb"　 \r\n', '"a\r\nb" ']) {
    assert.ok(lib.ParseCsv(text).every((x) => x.quoteTail === null), JSON.stringify(text));
  }
  // 閉じた引用符がファイルの終わり（末尾の改行なし）、CR だけ、CRLF
  for (const text of ['x,"a\nb"', 'x,"a\rb"\ry', 'x,"a\r\nb"\r\ny']) {
    assert.ok(lib.ParseCsv(text).every((x) => x.quoteTail === null), JSON.stringify(text));
  }
  // 改行と "" を含む値
  const q = lib.ParseCsv('"彼は""至急""と\n言った"\n');
  assert.deepEqual(q, [{ line: 1, fields: ['彼は"至急"と\n言った'], unclosedQuoteLine: 0, quoteTail: null }]);
  // 1 行の中の寛容な読み方は今までどおり
  assert.deepEqual(lib.ParseCsv('"abc"def\n'), [{ line: 1, fields: ['abcdef'], unclosedQuoteLine: 0, quoteTail: null }]);
  assert.deepEqual(errs(norm(HEADER4 + '2026/09/01,"商品"A,1,100\n', true)), []);
});

test('5.5 誤ってエラーになる例と逃げ道: 備考に 1 行分の CSV が書かれている → TRUE ではエラー、FALSE ではエラーなしで明細 1 行', () => {
  const text = H5 + '2026/09/01,商品A,1,100,"前回の注文\n2026/08/01,商品A,1,100,\nと同じ"\n';
  assert.deepEqual(errs(norm(text, true)), [[2, commaMsg(2, 4, '備考', 2, 4)]]);
  const off = norm(text, false);
  assert.deepEqual(off.errors, []);
  assert.equal(off.rows.length, 1);
});

test('5.5 版 5 で新しく誤ってエラーになる例: どの行もカンマ 2 個以下でも、値全体で 4 個なら当たる。FALSE ならエラーなし', () => {
  const text = H5 + '2026/09/01,商品A,1,100,"配送メモ, 午前着\n置き配可, 連絡先は別紙\n担当, 山田, 内線 12"\n';
  assert.deepEqual(errs(norm(text, true)), [[2, commaMsg(2, 4, '備考', 2, 4)]]);
  const off = norm(text, false);
  assert.deepEqual(off.errors, []);
  assert.equal(off.rows.length, 1);
});

test('5.5 境目: H = 5 で、改行を含む値のカンマが 3 個ならエラーなし、4 個ならエラー', () => {
  assert.deepEqual(norm(H5 + '2026/09/01,商品A,1,100,"a,b\nc,d,e"\n', true).errors, []); // 1 ＋ 2 ＝ 3 個
  assert.deepEqual(errs(norm(H5 + '2026/09/01,商品A,1,100,"a,b\nc,d,e,f"\n', true)), [[2, commaMsg(2, 3, '備考', 1, 4)]]); // 1 ＋ 3 ＝ 4 個
  // 改行のない値はカンマがいくつあっても判定 B の対象外
  assert.deepEqual(norm(H5 + '2026/09/01,商品A,1,100,"a,b,c,d,e,f"\n', true).errors, []);
});

test('5.5 行番号: 判定 B の値より左の列にも改行を含む値があるとき、startLine・endLine は元のファイルの行', () => {
  // 2 行目で始まるレコード。商品名に改行 1 つ（2・3 行目）、備考が 3 行目で始まり 5 行目で閉じる（カンマ 4 個）
  const text = H5 + '2026/09/01,"商品\nA",1,100,"a,b,c,d,e\nf\ng"\n2026/09/02,商品B,1,200,\n';
  assert.deepEqual(errs(norm(text, true)), [[3, commaMsg(3, 5, '備考', 2, 4)]]);
  assert.deepEqual(errs(norm(crlfOf(text), true)), [[3, commaMsg(3, 5, '備考', 2, 4)]]);
});

test('5.5 列名: 見出しの値が空の列は「5 列目」、見出しより右の列は「7 列目」（1 から数える）', () => {
  const cols = { date: '注文日', product: '商品名', quantity: '数量', amount: '金額', orderId: '' };
  // 判定 A: 見出しの 5 列目が空（空白だけも空とみなす）
  for (const blank of ['', ' ']) {
    const emptyHead = '注文日,商品名,数量,金額,' + blank + ',備考\n2026/09/01,商品A,1,100,"x\ny"z,\n';
    assert.deepEqual(lib.ParseCsv(emptyHead)[1].quoteTail, { startLine: 2, endLine: 3, field: 4 });
    assert.deepEqual(errs(norm(emptyHead, true, cols)), [[2, tailMsg(2, 3, '5 列目')]]);
  }
  // 判定 A: 見出しより右（7 列目）
  assert.deepEqual(errs(norm(HEADER4 + '2026/09/01,商品A,1,100,,,"x\ny"z\n', true, cols)), [[2, tailMsg(2, 3, '7 列目')]]);
  // 判定 B: 見出しより右（5 列目）
  assert.deepEqual(errs(norm(HEADER4 + '2026/09/01,商品A,1,100,"a,b,c,d\ne"\n', true, cols)), [[2, commaMsg(2, 3, '5 列目', 1, 3)]]);
  // 見出しの値は TrimText して使う
  assert.deepEqual(errs(norm('注文日,商品名,数量,金額,　備考 \n2026/09/01,商品A,1,100,"x\ny"z\n', true, cols)), [[2, tailMsg(2, 3, '備考')]]);
});

test('5.5 文言: 判定 A・B の文に波ダッシュ（〜 U+301C）も全角チルダ（～ U+FF5E）もない', () => {
  const all = [tailMsg(2, 5, '備考'), commaMsg(2, 4, '備考', 2, 8)].concat(
    errs(norm(EX1, true)).map((e) => e[1]), errs(norm(EX2, true)).map((e) => e[1]), [lib.QUOTE_TAIL_MESSAGE, lib.QUOTE_COMMA_MESSAGE]);
  for (const m of all) {
    assert.equal(typeof m, 'string');
    assert.ok(!m.includes('〜') && !m.includes('～'), m);
  }
});

test('5.5 1 レコードに複数当たるとき: 閉じていない引用符と判定 B → 閉じていない引用符の 1 件だけ。判定 A と B → 判定 A の 1 件だけ', () => {
  const text = H5 + '2026/09/01,商品A,1,100,"a,b,c,d\ne,f';
  assert.deepEqual(errs(norm(text, true)), [[2, lib.UNCLOSED_QUOTE_MESSAGE]]);
  // 例 1 の値は改行 3 個・カンマ 12 個で判定 B にも当たるが、判定 A の 1 件だけ
  assert.equal(norm(EX1, true).errors.length, 1);
  // 判定 B が 2 つの列で当たるときは一番左の列だけ
  const two = H5 + '"2026/09/01,a,b,c,d\nx","商品,a,b,c,d\ny",1,100,\n';
  assert.deepEqual(errs(norm(two, true)), [[2, commaMsg(2, 3, '注文日', 1, 4)]]);
});

test('5.5 閉じていない引用符・判定 A・判定 B に当たったデータのレコードでは、日付・商品・数量・金額のエラーを出さず、データ行には数える', () => {
  // 閉じていない引用符（商品名で始まり、数量・金額が空）
  const unclosed = norm(HEADER4 + '2026/10/01,X,1,100\n2026/10/02,"テスト,1,', true);
  assert.deepEqual(errs(unclosed), [[3, lib.UNCLOSED_QUOTE_MESSAGE]]);
  assert.equal(unclosed.dataRows, 2);
  // 判定 A（金額が空）
  const a = norm(HEADER4 + '2026/09/01,"商品A\nx"y,1,\n', true);
  assert.deepEqual(errs(a), [[2, tailMsg(2, 3, '商品名')]]);
  assert.equal(a.dataRows, 1);
  assert.deepEqual(a.rows, []);
  // 判定 B（日付が読めない）
  const b = norm(HEADER4 + '"abc,d,e,g\nf",商品,1,100\n2026/09/02,商品,x,1\n', true);
  assert.deepEqual(errs(b), [[2, commaMsg(2, 3, '注文日', 1, 3)], [4, '「数量」を数値として読めません: x']]);
  assert.equal(b.dataRows, 2);
  // QUOTE_CHECK = FALSE なら判定 B はしないので、同じレコードの日付のエラーが出る
  assert.deepEqual(errs(norm(HEADER4 + '"abc,d,e,g\nf",商品,1,100\n', false)), [[2, '「注文日」を日付として読めません: abc,d,e,g\nf']]);
});

test('5.5 見出しのレコードも判定 A・B の対象にする（audit 3 回目 必須 1）。当たったら列は探さず、データ行は 0。列名は値の最初の改行より前', () => {
  // 判定 B: 見出しの値のカンマ 4 個 ≥ H − 1 = 4
  const head = '注文日,商品名,数量,金額,"備,考,a,b,d\nc"\n2026/09/01,商品A,1,100,\n';
  const rb = norm(head, true);
  assert.deepEqual(errs(rb), [[1, commaMsg(1, 2, '備,考,a,b,d', 1, 4)]]);
  assert.deepEqual(rb.rows, []);
  assert.equal(rb.dataRows, 0);
  assert.deepEqual(norm(head, false).errors, []); // QUOTE_CHECK = FALSE なら判定 B はしない
  // カンマ 3 個（H − 2）なら当たらない
  assert.deepEqual(norm('注文日,商品名,数量,金額,"備,考,a,b\nc"\n2026/09/01,商品A,1,100,\n', true).errors, []);
  // 判定 A: QUOTE_CHECK に関係なく当たる
  const headTail = '注文日,商品名,数量,金額,"備\n考"x\n2026/09/01,商品A,1,100,\n';
  for (const qc of [true, false]) {
    const ra = norm(headTail, qc);
    assert.deepEqual(errs(ra), [[1, tailMsg(1, 2, '備')]]);
    assert.deepEqual(ra.rows, []);
  }
  // 必須の列で始まっても、「必要な列がない」は出さず引用符のエラー 1 件だけ
  assert.deepEqual(errs(norm('注文日,"商品名\n2026/09/01,商品A"x,数量,金額\n2026/09/02,商品B,1,200\n', true)), [[1, tailMsg(1, 2, '商品名')]]);
  // 見出しの前に空行があっても、行番号は元のファイルの行
  assert.deepEqual(errs(norm('\n\n' + headTail, true)), [[3, tailMsg(3, 4, '備')]]);
  // 捕まえられない形（README 9 の制限事項 1 の見出し版。今の動きを固定）: 閉じた " の後ろが , でカンマが H − 1 個に満たない → 2 行目が消える
  const missed = norm('注文日,商品名,数量,金額,"備考\n2026/09/01",商品A,1,100,\n2026/09/02,商品B,1,200,\n', true);
  assert.deepEqual(missed.errors, []);
  assert.deepEqual(missed.rows.map((x) => x.line), [3]);
});

test('5.5 AggregateFiles: settings.quoteCheck が false なら判定 B をしない。指定がなければ（版 3 の設定）検査する', () => {
  const files = [{ name: 'a.csv', bytes: utf8(EX4) }];
  const on = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  assert.deepEqual(on.errors, [{ file: 'a.csv', line: 2, message: commaMsg(2, 3, '商品名', 1, 3) }]);
  assert.equal(on.summary, undefined);
  assert.equal(on.reports[0].dataRows, 1);
  const off = lib.AggregateFiles(files, Object.assign(settingsOf(), { quoteCheck: false }), utf8Decode);
  assert.deepEqual(off.errors, []);
  assert.equal(off.details.length, 1);
  const explicitOn = lib.AggregateFiles(files, Object.assign(settingsOf(), { quoteCheck: true }), utf8Decode);
  assert.deepEqual(explicitOn.errors, on.errors);
  // 判定 A は QUOTE_CHECK = FALSE でも切れない
  const a = lib.AggregateFiles([{ name: 'a.csv', bytes: utf8(EX1) }], Object.assign(settingsOf(), { quoteCheck: false }), utf8Decode);
  assert.deepEqual(a.errors, [{ file: 'a.csv', line: 2, message: tailMsg(2, 5, '備考') }]);
});

// ---- tester 3 回目（仕様 版 5 の 5.5 の追加テスト） ----
const crOf = (s) => s.replace(/\n/g, '\r');
// 行ごとに LF・CRLF・CR を順に使う（1 つのファイルの中で改行コードが混ざる）
// CR のすぐ後ろが（次の改行の）LF になると 1 つの CRLF に読まれてしまうので、そのときは CRLF にする
const mixedOf = (s) => { let k = 0; return s.replace(/\n/g, (m, off, str) => { const c = ['\n', '\r\n', '\r'][k++ % 3]; return c === '\r' && str.charAt(off + 1) === '\n' ? '\r\n' : c; }); };
const NEWLINE_STYLES = [['LF', (s) => s], ['CRLF', crlfOf], ['CR', crOf], ['混在', mixedOf]];

test('5.5 見出しの行で始まった余分な " で行が黙って消えない（audit 3 回目 必須 1）: 閉じる " の後ろが文字', () => {
  // 修正前はエラー 0 件・明細 1 行（4 行目だけ）で、2 行目と 3 行目の売上が消えていた
  const text = '注文日,商品名,数量,金額,"備考\n2026/09/01,商品A,1,100,\n2026/09/02,商品B,1,200,"再送\n2026/09/03,商品C,1,300,\n';
  assert.deepEqual(lib.ParseCsv(text)[0].quoteTail, { startLine: 1, endLine: 3, field: 4 });
  for (const [style, conv] of NEWLINE_STYLES) {
    for (const qc of [true, false]) {
      const r = norm(conv(text), qc);
      assert.deepEqual(errs(r), [[1, tailMsg(1, 3, '備考')]], style + ' ' + qc);
      assert.deepEqual(r.rows, []);
    }
  }
  const agg = lib.AggregateFiles([{ name: 'a.csv', bytes: utf8(text) }], settingsOf(), utf8Decode);
  assert.deepEqual(agg.errors, [{ file: 'a.csv', line: 1, message: tailMsg(1, 3, '備考') }]);
  assert.equal(agg.summary, undefined);
});

test('5.5 見出しの行で始まった余分な " で行が黙って消えない（audit 3 回目 必須 1）: 閉じる " が行末', () => {
  const text = '注文日,商品名,数量,金額,"備考\n2026/09/01,商品A,1,100,\n2026/09/02,商品B,1,200,"\n2026/09/03,商品C,1,300,\n';
  assert.equal(lib.ParseCsv(text)[0].quoteTail, null);
  for (const [style, conv] of NEWLINE_STYLES) {
    const r = norm(conv(text), true);
    assert.deepEqual(errs(r), [[1, commaMsg(1, 3, '備考', 2, 8)]], style);
    assert.deepEqual(r.rows, []);
  }
  const agg = lib.AggregateFiles([{ name: 'a.csv', bytes: utf8(text) }], settingsOf(), utf8Decode);
  assert.deepEqual(agg.errors, [{ file: 'a.csv', line: 1, message: commaMsg(1, 3, '備考', 2, 8) }]);
  assert.equal(agg.summary, undefined);
  // QUOTE_CHECK = FALSE では捕まえられない（README 9 の制限事項。今の動きを固定）
  const off = norm(text, false);
  assert.deepEqual(off.errors, []);
  assert.equal(off.rows.length, 1);
});

test('5.5 例 1〜4 は LF・CRLF・CR だけ・1 ファイル内の混在のどれでも、同じ quoteTail・同じエラー・同じデータ行になる（QUOTE_CHECK の ON/OFF とも）', () => {
  const cases = [
    ['例 1', EX1, { startLine: 2, endLine: 5, field: 4 }, [[2, tailMsg(2, 5, '備考')]], [[2, tailMsg(2, 5, '備考')]], 2],
    ['例 2', EX2, null, [[2, commaMsg(2, 4, '備考', 2, 8)]], [], 2],
    ['例 3', EX3, { startLine: 2, endLine: 3, field: 1 }, [[2, tailMsg(2, 3, '商品名')]], [[2, tailMsg(2, 3, '商品名')]], 1],
    ['例 4', EX4, null, [[2, commaMsg(2, 3, '商品名', 1, 3)]], [], 1],
  ];
  for (const [name, text, tail, onErrors, offErrors, dataRows] of cases) {
    const lfRecs = lib.ParseCsv(text);
    for (const [style, conv] of NEWLINE_STYLES) {
      const label = name + ' ' + style;
      const recs = lib.ParseCsv(conv(text));
      assert.deepEqual(recs, lfRecs, label + ': ParseCsv の結果（値・行番号）が LF 版と同じ');
      assert.deepEqual(recs[1].quoteTail, tail, label);
      const on = norm(conv(text), true);
      assert.deepEqual(errs(on), onErrors, label + ' TRUE');
      assert.equal(on.dataRows, dataRows, label);
      assert.deepEqual(errs(norm(conv(text), false)), offErrors, label + ' FALSE');
    }
  }
});

test('5.5 判定 A の境目: 閉じた " の後ろが空白（半角・タブ・全角）のあと , ・CR・LF・ファイルの終わりなら当たらない', () => {
  const base = H5 + '2026/09/01,商品A,1,100,"a\nb"';
  for (const suffix of ['', ' ', '\t', '　', '   ', ' \t　', ',', ' ,', '\t,', '　,', ' ,x\n', '\n', ' \n', '\t\n', '　\r\n', '  \r', ' \t　\n2026/09/02,商品B,1,200,\n']) {
    const recs = lib.ParseCsv(base + suffix);
    assert.ok(recs.every((x) => x.quoteTail === null), JSON.stringify(suffix));
    assert.deepEqual(norm(base + suffix, true).errors, [], JSON.stringify(suffix));
  }
});

test('5.5 判定 A の境目: 閉じた " の後ろが空白のあと , ・改行・終わり以外（文字・全角カンマ・ノーブレークスペース）なら当たり、QUOTE_CHECK = FALSE でも切れない', () => {
  const base = H5 + '2026/09/01,商品A,1,100,"a\nb"';
  // ノーブレークスペース（U+00A0）は読み飛ばす空白に入っていない（仕様 5.5 は半角スペース・タブ・全角スペースだけ）
  for (const suffix of ['x', ' x', '\tx\n', '　x\r\n', ' \t　x', '，\n', ' \n', ' "\n', '\t"x"\n']) {
    const recs = lib.ParseCsv(base + suffix);
    assert.deepEqual(recs[1].quoteTail, { startLine: 2, endLine: 3, field: 4 }, JSON.stringify(suffix));
    for (const qc of [true, false]) {
      assert.deepEqual(errs(norm(base + suffix, qc)), [[2, tailMsg(2, 3, '備考')]], JSON.stringify(suffix) + ' ' + qc);
    }
  }
});

test('5.5 判定 A: 1 レコードで 2 か所当たるときは最初の 1 つ（左の列）。左の列に改行を含む値があっても、startLine はその引用符が始まった行', () => {
  const two = H5 + '2026/09/01,"商品\nA"x,1,100,"c\nd"y\n';
  assert.deepEqual(lib.ParseCsv(two)[1].quoteTail, { startLine: 2, endLine: 3, field: 1 });
  assert.deepEqual(errs(norm(two, true)), [[2, tailMsg(2, 3, '商品名')]]);
  // 左の列（商品名）は正しく閉じ、右の列（備考）で当たる → startLine は 3 行目
  const right = H5 + '2026/09/01,"商品\nA",1,100,"c\nd\ne"y\n';
  assert.deepEqual(lib.ParseCsv(right)[1].quoteTail, { startLine: 3, endLine: 5, field: 4 });
  assert.deepEqual(errs(norm(right, true)), [[3, tailMsg(3, 5, '備考')]]);
});

// 見出し H 列（4 列の必須 ＋ 備考1…備考m）、改行を 1 つ含む値にカンマを commas 個入れた CSV
function headerBoundaryCsv(h, commas) {
  const extra = [];
  for (let k = 1; k <= h - 4; k++) extra.push('備考' + k);
  const head = ['注文日', '商品名', '数量', '金額'].concat(extra).join(',') + '\n';
  const half = Math.floor(commas / 2);
  const value = '"x' + ','.repeat(half) + '\n' + ','.repeat(commas - half) + 'y"';
  // 値は最後の列（H = 4 のときは見出しより右の 5 列目）に置く
  const cells = ['2026/09/01', '商品A', '1', '100'];
  for (let k = 1; k < h - 4; k++) cells.push('');
  cells.push(value);
  return { text: head + cells.join(',') + '\n', column: h === 4 ? '5 列目' : '備考' + (h - 4) };
}

test('5.5 判定 B の境目: H = 4・5・6・9 で、改行を含む値のカンマが H − 2 個ならエラーなし、H − 1 個ならエラー。FALSE ならどちらもエラーなし', () => {
  for (const h of [4, 5, 6, 9]) {
    for (const [style, conv] of NEWLINE_STYLES) {
      const below = headerBoundaryCsv(h, h - 2);
      const r = norm(conv(below.text), true);
      assert.deepEqual(r.errors, [], `H=${h} ${style} H-2`);
      assert.equal(r.rows.length, 1);
      const at = headerBoundaryCsv(h, h - 1);
      assert.deepEqual(errs(norm(conv(at.text), true)), [[2, commaMsg(2, 3, at.column, 1, h - 1)]], `H=${h} ${style} H-1`);
      assert.deepEqual(norm(conv(at.text), false).errors, [], `H=${h} ${style} H-1 FALSE`);
    }
  }
});

test('5.5 "" のエスケープを含む複数行の値: 閉じた引用符の直前の "" や、行頭の "" で判定 A に当たらない。"" はカンマに数えない', () => {
  const ok = [
    ['"彼は""至急""と\n言った"""', '彼は"至急"と\n言った"'],
    ['"""\n"""', '"\n"'],
    ['"a\n""b"",c"', 'a\n"b",c'],
    ['"""a""\n"', '"a"\n'],
    ['"\n"', '\n'],
    ['"a\n""\nb"', 'a\n"\nb'],
  ];
  for (const [quoted, value] of ok) {
    for (const [style, conv] of NEWLINE_STYLES) {
      const text = conv(H5 + '2026/09/01,商品A,1,100,' + quoted + '\n2026/09/02,商品B,1,200,\n');
      const recs = lib.ParseCsv(text);
      assert.equal(recs[1].fields[4], value, quoted + ' ' + style);
      assert.ok(recs.every((x) => x.quoteTail === null && x.unclosedQuoteLine === 0), quoted + ' ' + style);
      const r = norm(text, true);
      assert.deepEqual(r.errors, [], quoted + ' ' + style);
      assert.deepEqual(r.rows.map((x) => x.line), [2, 2 + 1 + (value.match(/\n/g) || []).length]);
    }
  }
  // 本当に閉じた " の後ろに文字があれば、"" を含んでいても判定 A に当たる
  assert.deepEqual(errs(norm(H5 + '2026/09/01,商品A,1,100,"a\n""b"""x\n', true)), [[2, tailMsg(2, 3, '備考')]]);
  // "" の 4 個の " はカンマに数えない: カンマ 3 個（H − 2）ならエラーなし、4 個ならエラーで「カンマが 4 個」
  assert.deepEqual(norm(H5 + '2026/09/01,商品A,1,100,"""a"",b\n""c"",d,e"\n', true).errors, []);
  assert.deepEqual(errs(norm(H5 + '2026/09/01,商品A,1,100,"""a"",b\n""c"",d,e,f"\n', true)), [[2, commaMsg(2, 3, '備考', 1, 4)]]);
  // 最後が "" のエスケープでファイルが終わると、引用符は閉じていない
  assert.deepEqual(errs(norm(H5 + '2026/09/01,商品A,1,100,"a\nb""', true)), [[2, lib.UNCLOSED_QUOTE_MESSAGE]]);
});

test('5.5 1 ファイルに判定 A と判定 B が両方あるとき: レコードごとに 1 件ずつ、行の順。正しい行は明細に残るがエラーなので集計は作らない', () => {
  const text = H5
    + '2026/09/01,商品A,1,100,\n'                         // 2: 正しい
    + '2026/09/02,商品B,1,200,"至急\n'                    // 3: 判定 A（5 行目で閉じて後ろに文字）
    + '2026/09/03,商品C,1,300,\n'                         // 4
    + '2026/09/04,商品D,1,400,"再送\n'                    // 5
    + '2026/09/05,商品E,1,500,\n'                         // 6: 正しい
    + '2026/09/06,商品F,1,600,"メモ\n'                    // 7: 判定 B（9 行目の行末で閉じる）
    + '2026/09/07,商品G,1,700,\n'                         // 8
    + '2026/09/08,商品H,1,800,"\n'                        // 9
    + '2026/09/09,商品I,1,900,\n';                        // 10: 正しい
  for (const [style, conv] of NEWLINE_STYLES) {
    const r = norm(conv(text), true);
    assert.deepEqual(errs(r), [[3, tailMsg(3, 5, '備考')], [7, commaMsg(7, 9, '備考', 2, 8)]], style);
    assert.equal(r.dataRows, 5, style);
    assert.deepEqual(r.rows.map((x) => x.line), [2, 6, 10], style);
    // FALSE なら判定 A だけ残る（判定 B の 7 行目のレコードは明細になり、8・9 行目は消える）
    const off = norm(conv(text), false);
    assert.deepEqual(errs(off), [[3, tailMsg(3, 5, '備考')]], style);
    assert.deepEqual(off.rows.map((x) => x.line), [2, 6, 7, 10], style);
  }
  const files = [{ name: 'a.csv', bytes: utf8(text) }];
  const agg = lib.AggregateFiles(files, Object.assign(settingsOf(), { quoteCheck: true }), utf8Decode);
  assert.equal(agg.summary, undefined);
  assert.deepEqual(agg.errors.map((e) => [e.file, e.line]), [['a.csv', 3], ['a.csv', 7]]);
});

test('エラーの並び順: 同じファイルの中は行番号の順（同じ行は出した順のまま）、ファイルはファイル名の順（テスト 3 回目 気づいたこと 1）', () => {
  // テスト 3 回目の再現: 2 行目の判定 A と、4 行目で始まる閉じていない引用符
  const repro = H5 + '2026/09/01,商品A,1,100,"a\nb"x\n2026/09/02,商品B,1,200,"c\n';
  // 同じ行に 2 件（数量・金額）と、後ろのレコードの閉じていない引用符
  const many = HEADER4 + '2026/09/01,商品A,x,y\n2026/09/02,"商品B,1,200\n';
  const files = [{ name: 'b.csv', bytes: utf8(repro) }, { name: 'a.csv', bytes: utf8(many) }];
  const r = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  assert.deepEqual(r.errors.map((e) => [e.file, e.line, e.message]), [
    ['a.csv', 2, '「数量」を数値として読めません: x'],
    ['a.csv', 2, '「金額」を数値として読めません: y'],
    ['a.csv', 3, lib.UNCLOSED_QUOTE_MESSAGE],
    ['b.csv', 2, tailMsg(2, 3, '備考')],
    ['b.csv', 4, lib.UNCLOSED_QUOTE_MESSAGE],
  ]);
});

test('5.5 閉じていない引用符と判定 A が別のレコードにあるとき: 2 件とも出て、行番号の順に並ぶ（テスト 3 回目 気づいたこと 1）', () => {
  const text = H5 + '2026/09/01,商品A,1,100,"a\nb"x\n2026/09/02,商品B,1,200,"c\n';
  assert.deepEqual(errs(norm(text, true)), [[2, tailMsg(2, 3, '備考')], [4, lib.UNCLOSED_QUOTE_MESSAGE]]);
  // 同じレコードで、判定 A のあとに閉じていない引用符が始まる → 閉じていない引用符の 1 件だけ
  const same = H5 + '2026/09/01,"商品\nA"x,1,100,"c\n';
  assert.deepEqual(lib.ParseCsv(same)[1].quoteTail, { startLine: 2, endLine: 3, field: 1 });
  assert.deepEqual(errs(norm(same, true)), [[3, lib.UNCLOSED_QUOTE_MESSAGE]]);
});

test('5.5 行番号: 見出しの前・レコードの間に空行があり、BOM つきでも、判定 A・B の行は元のファイルの行', () => {
  const text = '﻿\n\n' + H5 + '\n2026/09/01,商品A,1,100,"至急\n2026/09/02,商品B,1,200,\n2026/09/03,商品C,1,300,"x\n\n'
    + '2026/09/04,"商品D,1,400,\n2026/09/05,商品E",1,500,\n';
  // 1・2 行目が空、3 行目が見出し、4 行目が空、5 行目で備考が始まり 7 行目で閉じて後ろに x（判定 A）
  // 8 行目が空、9 行目で商品名が始まり 10 行目の行末ではなく途中で閉じ、後ろが , → 判定 B（カンマ 3 + 1 = 4 個）
  for (const [style, conv] of NEWLINE_STYLES) {
    const files = [{ name: 'a.csv', bytes: utf8(conv(text)) }];
    const r = lib.AggregateFiles(files, settingsOf(), utf8Decode);
    assert.deepEqual(r.errors.map((e) => [e.line, e.message]), [[5, tailMsg(5, 7, '備考')], [9, commaMsg(9, 10, '商品名', 1, 4)]], style);
  }
});

test('5.5 見出しの列数が多い（Excel が後ろに空の列を付けた形で、データの行にも同じ数のカンマがある）: 同じ列で開いて閉じる形（例 4）を捕まえる', () => {
  // H = 7（後ろに空の見出し 3 つ）。データの行も 7 列
  const text = '注文日,商品名,数量,金額,,,\n2026/09/01,"商品A,1,100,,,\n2026/09/02,商品B",1,200,,,\n';
  // 値は「商品A,1,100,,,\n2026/09/02,商品B」でカンマ 5 + 1 = 6 個 ≥ H − 1 = 6
  assert.deepEqual(errs(norm(text, true)), [[2, commaMsg(2, 3, '商品名', 1, 6)]]);
  assert.deepEqual(errs(norm(crOf(text), true)), [[2, commaMsg(2, 3, '商品名', 1, 6)]]);
});

test('5.5 見出しの列数が多い（データの行は後ろの空の列を省く）: 例 4 の形でもエラーにならず、1 行消える（捕まえられない例。今の動きを固定）', () => {
  // H = 5 だが、データの行は 4 列（備考を省く）。値のカンマは 2 + 1 = 3 個 < H − 1 = 4
  const text = H5 + '2026/09/01,"商品A,1,100\n2026/09/02,商品B",1,200\n';
  const r = norm(text, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.dataRows, 1);
  // 商品名に改行が入るので、README の「明細」シートの Ctrl+J の検索で見つけられる形
  assert.deepEqual(r.rows.map((x) => [x.line, x.product, x.amount]), [[2, '商品A,1,100\n2026/09/02,商品B', 200]]);
});

test('5.5 見出しの列数が少ない（データの行に見出しより右の列がある）: 閾値が下がるので例 4 の形は捕まえ、正しい複数行の値は誤ってエラーになりやすい（今の動きを固定）', () => {
  // H = 4、データの行は 6 列
  const stray = HEADER4 + '2026/09/01,"商品A,1,100,x,y\n2026/09/02,商品B",1,200,x,y\n';
  assert.deepEqual(errs(norm(stray, true)), [[2, commaMsg(2, 3, '商品名', 1, 5)]]);
  // 見出しより右の 6 列目に、カンマ 3 個の複数行のメモ → H − 1 = 3 で当たる（誤ってエラー）。FALSE なら明細 1 行
  const note = HEADER4 + '2026/09/01,商品A,1,100,x,"配送, 午前\n置き配, 可, 別紙"\n';
  assert.deepEqual(errs(norm(note, true)), [[2, commaMsg(2, 3, '6 列目', 1, 3)]]);
  assert.equal(norm(note, false).rows.length, 1);
});

test('5.5 当たったレコードと「取り込み結果」・重複の削除: エラーのときもデータ行には数え、使った行には数えない。FALSE で吸い込まれた行はデータ行から消え、別ファイルの重なりで戻る', () => {
  // QUOTE_CHECK = TRUE: 例 2 のファイルは 2 レコード（2 行目と 5 行目）。2 行目のレコードは判定 B
  const ex2 = { name: 'a_ex2.csv', bytes: utf8(EX2) };
  const on = lib.AggregateFiles([ex2], settingsOf(), utf8Decode);
  assert.equal(on.summary, undefined);
  assert.deepEqual(on.reports, [{ file: 'a_ex2.csv', encoding: lib.ENCODING_UTF8, dataRows: 2, usedRows: 1, removed: 0 }]);
  // QUOTE_CHECK = FALSE: 物理的なデータの行は 4 行だが、データ行は 2（README の確かめ方で気づける差）
  const offSettings = Object.assign(settingsOf(), { quoteCheck: false });
  const off = lib.AggregateFiles([ex2], offSettings, utf8Decode);
  assert.deepEqual(off.errors, []);
  assert.deepEqual(off.reports, [{ file: 'a_ex2.csv', encoding: lib.ENCODING_UTF8, dataRows: 2, usedRows: 2, removed: 0 }]);
  assert.deepEqual(off.details.map((x) => [x.line, x.product, x.amount]), [[2, '商品A', 100], [5, '商品D', 400]]);
  assert.deepEqual(off.monthly.map((x) => [x.ym, x.amount]), [['2026-09', 500]]);
  // 期間が重なる別の CSV に、吸い込まれた 9/02・9/03 の行と 9/01 の行がある → 9/01 は重複で除かれ、9/02・9/03 は残る
  const overlap = { name: 'b_overlap.csv', bytes: utf8(H5 + '2026/09/01,商品A,1,100,\n2026/09/02,商品B,1,200,\n2026/09/03,商品C,1,300,\n') };
  const both = lib.AggregateFiles([ex2, overlap], offSettings, utf8Decode);
  assert.deepEqual(both.errors, []);
  assert.deepEqual(both.reports.map((x) => [x.file, x.dataRows, x.usedRows, x.removed]), [['a_ex2.csv', 2, 2, 0], ['b_overlap.csv', 3, 2, 1]]);
  assert.deepEqual(both.monthly.map((x) => [x.ym, x.amount]), [['2026-09', 1000]]);
  // TRUE で、エラーのレコード（2 行目の商品A）は明細に入らないので、別ファイルの同じ行を「重複」として除かない
  const bothOn = lib.AggregateFiles([ex2, overlap], settingsOf(), utf8Decode);
  assert.deepEqual(bothOn.errors.map((e) => [e.file, e.line]), [['a_ex2.csv', 2]]);
  assert.deepEqual(bothOn.reports.map((x) => [x.file, x.dataRows, x.usedRows, x.removed]), [['a_ex2.csv', 2, 1, 0], ['b_overlap.csv', 3, 3, 0]]);
});

test('5.5 当たったファイルを 2 回読んでも同じエラーで、入力のバイト列を変えない', () => {
  const bytes = utf8(crlfOf(EX1 + EX2.slice(H5.length)));
  const before = Buffer.from(bytes).toString('base64');
  const files = [{ name: 'a.csv', bytes }];
  const r1 = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  const r2 = lib.AggregateFiles(files, settingsOf(), utf8Decode);
  assert.deepEqual(r1, r2);
  assert.ok(r1.errors.length >= 2);
  assert.equal(Buffer.from(bytes).toString('base64'), before);
});

test('5.5 正しい CSV（すべての値を引用符で囲む出力元）: 複数行・カンマ・"" ・空の値 "" を含んでもエラーにならない', () => {
  const text = '"注文日","商品名","数量","金額","備考"\r\n'
    + '"2026/09/01","商品A","1","100",""\r\n'
    + '"2026/09/02","商品""B""","1","200","配送メモ\r\n午前着, 置き配可\r\n""至急""と連絡あり"\r\n'
    + '"2026/09/03","商品C","1","300","\r\n"\r\n'
    + '"","","","",""\r\n'
    + '"2026/09/04","商品D","1","400","a, b\r\n"';
  for (const [style, conv] of [['CRLF', (s) => s], ['LF', (s) => s.replace(/\r\n/g, '\n')], ['CR', (s) => s.replace(/\r\n/g, '\r')]]) {
    const recs = lib.ParseCsv(conv(text));
    assert.ok(recs.every((x) => x.quoteTail === null && x.unclosedQuoteLine === 0), style);
    const r = norm(conv(text), true);
    assert.deepEqual(r.errors, [], style);
    assert.deepEqual(r.rows.map((x) => [x.line, x.product]), [[2, '商品A'], [3, '商品"B"'], [6, '商品C'], [9, '商品D']], style);
    assert.equal(recs[2].fields[4], '配送メモ\n午前着, 置き配可\n"至急"と連絡あり');
  }
});

test('5.5 正しい CSV（すべて引用符で囲む出力元）に、エスケープしていない " が 1 つ入ると判定 A で捕まる（黙って行が消えない）', () => {
  // 備考の値が " 1 文字で、エスケープせずに """ と出た → 次の行の先頭の " で閉じ、後ろに 2026/… が続く
  const text = '"注文日","商品名","数量","金額","備考"\n"2026/09/01","商品A","1","100","""\n"2026/09/02","商品B","1","200",""\n';
  for (const [style, conv] of NEWLINE_STYLES) {
    for (const qc of [true, false]) {
      assert.deepEqual(errs(norm(conv(text), qc)), [[2, tailMsg(2, 3, '備考')]], style + ' ' + qc);
    }
  }
});

// 決まった順に値を作る疑似乱数（毎回同じテストになるように）
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test('5.5 正しい CSV（RFC 4180 で書いたもの）を 300 通り作り、判定 A に一度も当たらず、値と行番号がそのまま読めることを確かめる。改行を含む値のカンマが H − 2 個以下なら判定 B にも当たらない', () => {
  const rand = makeRandom(20261014);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const pieces = ['a', 'メモ', ' ', '　', '\t', ',', '"', '""', '\n', '\r\n', '\r', 'x"y', '1,960', ''];
  let multilineValues = 0;
  for (let t = 0; t < 300; t++) {
    const h = 4 + Math.floor(rand() * 4); // 4〜7 列
    const head = ['注文日', '商品名', '数量', '金額'].concat(['備考', '担当', '店舗'].slice(0, h - 4));
    const eol = pick(['\n', '\r\n', '\r']);
    const quoteAll = rand() < 0.3;
    const lines = [];
    const expected = [];
    let line = 1;
    const rows = [head];
    for (let r = 0; r < 1 + Math.floor(rand() * 5); r++) {
      const row = ['2026/09/' + String(1 + r).padStart(2, '0'), '商品' + r, String(1 + r), String(100 * (r + 1))];
      for (let k = 4; k < h; k++) {
        let v = '';
        for (let p = 0; p < Math.floor(rand() * 6); p++) v += pick(pieces);
        // 改行を含む値はカンマを H − 2 個までにする（判定 B の閾値の手前）
        if (/[\r\n]/.test(v)) {
          let extra = (v.match(/,/g) || []).length - (h - 2);
          while (extra-- > 0) v = v.replace(',', '、');
        }
        row.push(v);
      }
      rows.push(row);
    }
    for (const row of rows) {
      const cells = row.map((v) => (quoteAll || /[",\r\n]/.test(v) || /^[ \t　]|[ \t　]$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v));
      lines.push(cells.join(','));
      const norm1 = row.map((v) => v.replace(/\r\n|\r/g, '\n'));
      expected.push({ line, fields: norm1 });
      for (const v of norm1) { const nl = (v.match(/\n/g) || []).length; line += nl; if (nl > 0) multilineValues++; }
      line++;
    }
    const text = lines.join(eol) + (rand() < 0.5 ? eol : '');
    const recs = lib.ParseCsv(text);
    const label = 'case ' + t + ' ' + JSON.stringify(text);
    assert.deepEqual(recs.map((x) => ({ line: x.line, fields: x.fields })), expected, label);
    assert.ok(recs.every((x) => x.quoteTail === null && x.unclosedQuoteLine === 0), label);
    const r = lib.NormalizeRows('t.csv', recs, NO_ID, true);
    assert.deepEqual(r.errors, [], label);
    assert.equal(r.rows.length, rows.length - 1, label);
  }
  // 改行を含む値を十分に作れていること（テストが空回りしていない）
  assert.ok(multilineValues > 100, String(multilineValues));
});
