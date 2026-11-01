const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib.js');

test('formatDateKey: yyyyMMdd 形式になる', () => {
  assert.equal(lib.formatDateKey(new Date(2026, 0, 5)), '20260105');
});

test('nextInquiryId: その日の最初は 001', () => {
  assert.equal(lib.nextInquiryId([], '20261013'), 'INQ-20261013-001');
});

test('nextInquiryId: 同じ日の最大番号 +1、他の日や空欄は無視', () => {
  const ids = ['INQ-20261012-009', 'INQ-20261013-001', 'INQ-20261013-003', '', null, 42];
  assert.equal(lib.nextInquiryId(ids, '20261013'), 'INQ-20261013-004');
});

test('nextInquiryId: 接頭辞を変えられる', () => {
  assert.equal(lib.nextInquiryId([], '20261013', 'HEAR'), 'HEAR-20261013-001');
});

test('renderTemplate: 日本語キーを差し込み、ないキーは空にする', () => {
  const out = lib.renderTemplate('{{お名前}} 様 {{ 受付番号 }} {{不明}}!', { 'お名前': '山田', '受付番号': 'INQ-1' });
  assert.equal(out, '山田 様 INQ-1 !');
});

test('renderTemplate: テンプレートが空でも落ちない', () => {
  assert.equal(lib.renderTemplate(undefined, {}), '');
});

test('isValidEmail: 形式チェック', () => {
  assert.equal(lib.isValidEmail('a@example.com'), true);
  assert.equal(lib.isValidEmail(' a@example.com '), true);
  assert.equal(lib.isValidEmail('a@example'), false);
  assert.equal(lib.isValidEmail(''), false);
  assert.equal(lib.isValidEmail(undefined), false);
});

test('parseConfig: TRUE/FALSE を真偽値にし、空キーを無視する', () => {
  const config = lib.parseConfig([
    ['DRY_RUN', 'TRUE'],
    ['FLAG', 'false'],
    ['NAME', '  窓口  '],
    ['', 'ignored'],
    ['COUNT', 3],
  ]);
  assert.deepEqual(config, { DRY_RUN: true, FLAG: false, NAME: '窓口', COUNT: 3 });
});

test('missingConfigKeys: 未入力の必須キーを返す', () => {
  assert.deepEqual(lib.missingConfigKeys({ A: 'x', B: '' }, ['A', 'B', 'C']), ['B', 'C']);
});

test('flattenNamedValues: 配列を結合する', () => {
  const out = lib.flattenNamedValues({ 'お名前': ['山田'], '興味': ['A', 'B'] });
  assert.deepEqual(out, { 'お名前': '山田', '興味': 'A, B' });
});

test('formatAnswers: 質問ごとに見出しをつける', () => {
  assert.equal(lib.formatAnswers({ 'Q1': 'a', 'Q2': 'b' }), '■ Q1\na\n\n■ Q2\nb');
});
