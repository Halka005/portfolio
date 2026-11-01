const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib.js');

test('calcInvoice: 明細の金額、税率ごとの小計と消費税、合計', () => {
  const r = lib.calcInvoice([
    { name: '保守', quantity: 1, unitPrice: 30000, taxRate: 10 },
    { name: '作業', quantity: 3, unitPrice: 5000, taxRate: 10 },
    { name: '茶菓子', quantity: 1, unitPrice: 1080, taxRate: 8 },
  ]);
  assert.deepEqual(r.lines.map((l) => l.amount), [30000, 15000, 1080]);
  assert.deepEqual(r.taxes, [
    { taxRate: 10, subtotal: 45000, tax: 4500 },
    { taxRate: 8, subtotal: 1080, tax: 86 }, // 86.4 → 切り捨て
  ]);
  assert.equal(r.subtotal, 46080);
  assert.equal(r.tax, 4586);
  assert.equal(r.total, 50666);
});

test('calcInvoice: 消費税は明細ごとではなく税率ごとに 1 回だけ端数処理する', () => {
  // 明細ごとに処理すると 99.9→99 が 3 回で 297。税率ごとなら 2997 * 0.1 = 299.7 → 299
  const items = [1, 2, 3].map(() => ({ name: 'x', quantity: 1, unitPrice: 999, taxRate: 10 }));
  assert.equal(lib.calcInvoice(items).tax, 299);
});

test('calcInvoice: 端数処理を切り替えられる', () => {
  const items = [{ name: 'x', quantity: 1, unitPrice: 1005, taxRate: 10 }]; // 税 100.5
  assert.equal(lib.calcInvoice(items, 'floor').tax, 100);
  assert.equal(lib.calcInvoice(items, 'round').tax, 101);
  assert.equal(lib.calcInvoice(items, 'ceil').tax, 101);
});

test('calcInvoice: 小数の数量も扱える（金額は端数処理）', () => {
  const r = lib.calcInvoice([{ name: '作業時間', quantity: 1.5, unitPrice: 3333, taxRate: 10 }]);
  assert.equal(r.lines[0].amount, 4999); // 4999.5 → 切り捨て
});

test('validateItems: 不備を行番号つきで返す', () => {
  const errors = lib.validateItems([
    { rowNumber: 2, customerId: 'C001', name: 'ok', quantity: 1, unitPrice: 100, taxRate: 10 },
    { rowNumber: 3, customerId: 'C999', name: '', quantity: 0, unitPrice: -1, taxRate: 5 },
    { rowNumber: 4, customerId: '', name: 'x', quantity: '1', unitPrice: 100, taxRate: 8 },
  ], ['C001']);
  assert.deepEqual(errors, [
    '3 行目: 顧客ID「C999」が顧客シートにありません',
    '3 行目: 品目が空です',
    '3 行目: 数量は 0 より大きい数値にしてください',
    '3 行目: 単価は 0 以上の数値にしてください',
    '3 行目: 税率は 10 / 8 / 0 のいずれかにしてください',
    '4 行目: 顧客ID が空です',
    '4 行目: 数量は 0 より大きい数値にしてください',
  ]);
});

test('groupByCustomer: 出現順を保ってまとめる', () => {
  const g = lib.groupByCustomer([{ customerId: 'B' }, { customerId: 'A' }, { customerId: 'B' }]);
  assert.deepEqual(g.map((x) => [x.customerId, x.items.length]), [['B', 2], ['A', 1]]);
});

test('nextInvoiceNumber: 同じ月の最大番号 +1', () => {
  assert.equal(lib.nextInvoiceNumber([], '202610'), 'INV-202610-001');
  assert.equal(lib.nextInvoiceNumber(['INV-202609-007', 'INV-202610-002', '', null], '202610'), 'INV-202610-003');
});

test('normalizeYearMonth: いろいろな書き方と日付を受け付ける', () => {
  assert.equal(lib.normalizeYearMonth('2026-10'), '202610');
  assert.equal(lib.normalizeYearMonth('2026/1'), '202601');
  assert.equal(lib.normalizeYearMonth('202610'), '202610');
  assert.equal(lib.normalizeYearMonth("'2026-10"), '202610');
  assert.equal(lib.normalizeYearMonth(new Date(2026, 9, 1)), '202610');
  assert.equal(lib.normalizeYearMonth('2026-13'), null);
  assert.equal(lib.normalizeYearMonth('abc'), null);
  assert.equal(lib.normalizeYearMonth(new Date('invalid')), null);
});

test('calcDueDate: 翌月末・当月末・日数', () => {
  const d = new Date(2026, 0, 31); // 2026-01-31
  assert.equal(lib.formatDateJa(lib.calcDueDate(d, '翌月末')), '2026年2月28日');
  assert.equal(lib.formatDateJa(lib.calcDueDate(d, '当月末')), '2026年1月31日');
  assert.equal(lib.formatDateJa(lib.calcDueDate(d, 30)), '2026年3月2日');
  assert.equal(lib.formatDateJa(lib.calcDueDate(new Date(2026, 11, 15), '翌月末')), '2027年1月31日');
  assert.throws(() => lib.calcDueDate(d, '来週'));
});

test('isValidRegistrationNumber: T + 13 桁', () => {
  assert.equal(lib.isValidRegistrationNumber('T1234567890123'), true);
  assert.equal(lib.isValidRegistrationNumber('1234567890123'), false);
  assert.equal(lib.isValidRegistrationNumber('T123'), false);
});

test('formatYen: 3 桁区切り', () => {
  assert.equal(lib.formatYen(0), '¥0');
  assert.equal(lib.formatYen(1234567), '¥1,234,567');
});

test('escapeHtml: HTML の特殊文字を無害化する', () => {
  assert.equal(lib.escapeHtml('<b>"A&B"</b>'), '&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
});

test('renderInvoiceHtml: 必要な項目が入り、入力値はエスケープされる', () => {
  const calc = lib.calcInvoice([
    { name: '<script>', quantity: 1, unitPrice: 1000, taxRate: 10 },
    { name: '茶菓子', quantity: 1, unitPrice: 1080, taxRate: 8 },
  ]);
  const html = lib.renderInvoiceHtml({
    invoiceNumber: 'INV-202610-001',
    issueDate: new Date(2026, 9, 31),
    dueDate: new Date(2026, 10, 30),
    calc,
    customer: { name: '株式会社サンプル', honorific: '御中', contact: '山田' },
    issuer: { name: '発行者', address: '住所', registrationNumber: 'T1234567890123', bank: '銀行\n口座' },
  });
  assert.match(html, /INV-202610-001/);
  assert.match(html, /株式会社サンプル 御中/);
  assert.match(html, /登録番号: T1234567890123/);
  assert.match(html, /ご請求金額（税込） ¥2,266/);
  assert.match(html, /8% 対象/);
  assert.match(html, /軽減税率/);
  assert.match(html, /銀行<br>口座/);
  assert.doesNotMatch(html, /<script>/);
});

test('renderTemplate / isValidEmail / safeFileName', () => {
  assert.equal(lib.renderTemplate('{{会社名}} {{x}}', { '会社名': 'A' }), 'A ');
  assert.equal(lib.isValidEmail('a@example.com'), true);
  assert.equal(lib.isValidEmail('a@'), false);
  assert.equal(lib.safeFileName('A/B:C?.pdf'), 'A_B_C_.pdf');
});

test('parseConfigRows: 文字の値だけ trim と TRUE / FALSE の変換をし、真偽値・数・日付はそのまま。キーが空の行は飛ばす', () => {
  const date = new Date(2026, 9, 1);
  const c = lib.parseConfigRows([
    ['DRY_RUN', 'TRUE', '説明'],
    [' A ', ' false ', ''],
    ['B', true],
    ['C', false],
    ['D', 0],
    ['E', 123],
    ['F', '  サンプル  '],
    ['G', 'True'],
    ['H', date],
    ['', 'x'],
    [null, 'y'],
  ]);
  assert.deepEqual(Object.keys(c), ['DRY_RUN', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.equal(c.DRY_RUN, true);
  assert.equal(c.A, false);
  assert.equal(c.B, true);
  assert.equal(c.C, false);
  assert.equal(c.D, 0);
  assert.equal(c.E, 123);
  assert.equal(c.F, 'サンプル');
  assert.equal(c.G, true);
  assert.equal(c.H, date);
  assert.deepEqual(lib.parseConfigRows([]), {});
});

test('sampleData: 2 社と 4 行。請求月は先頭に \' を付けた文字。呼ぶたびに別の配列', () => {
  const d = lib.sampleData('2026-10');
  assert.deepEqual(d.customers, [
    ['C001', '株式会社サンプル商事', '御中', '山田 太郎', 'yamada@example.com'],
    ['C002', 'テスト合同会社', '御中', '佐藤 花子', 'sato@example.com'],
  ]);
  assert.deepEqual(d.items, [
    ["'2026-10", 'C001', 'Web サイト保守（月額）', 1, 30000, 10],
    ["'2026-10", 'C001', '更新作業', 3, 5000, 10],
    ["'2026-10", 'C002', 'データ入力代行', 120, 50, 10],
    ["'2026-10", 'C002', '打ち合わせ用 茶菓子', 1, 1080, 8],
  ]);
  d.customers[0][4] = '';
  assert.equal(lib.sampleData('2026-10').customers[0][4], 'yamada@example.com');
  assert.equal(lib.normalizeYearMonth(lib.sampleData('2026-11').items[0][0]), '202611');
});
