/**
 * main.js の結合テスト。
 * SpreadsheetApp などの GAS サービスを簡易的な偽物（モック）に置き換えて、
 * フォーム送信 → 受付番号の発行 → メール → 管理列の更新 → ログ の流れを確認する。
 * 実際の Google 環境での動作は README の「動作確認チェックリスト」で確認する。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeSheet(name, rows) {
  const data = rows.map((r) => r.slice());
  const width = () => Math.max(0, ...data.map((r) => r.length));
  const cell = (r, c) => (data[r - 1] && data[r - 1][c - 1] !== undefined ? data[r - 1][c - 1] : '');
  const range = (r, c, nr = 1, nc = 1) => {
    const self = {
      getRow: () => r,
      getSheet: () => sheet,
      getValue: () => cell(r, c),
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      setValue: (v) => self.setValues([[v]]),
      setValues: (vals) => {
        vals.forEach((rowVals, i) => rowVals.forEach((v, j) => {
          while (data.length < r + i) data.push([]);
          data[r + i - 1][c + j - 1] = v;
        }));
        return self;
      },
      setFontWeight: () => self, setBackground: () => self, setWrap: () => self, setDataValidation: () => self,
    };
    return self;
  };
  const sheet = {
    name, data,
    getName: () => name,
    getRange: range,
    getLastRow: () => data.length,
    getLastColumn: () => width(),
    getMaxRows: () => 1000,
    appendRow: (row) => data.push(row.slice()),
    setColumnWidth: () => {}, setFrozenRows: () => {},
  };
  return sheet;
}

// config が null なら「設定」シートを作らない。withLog が false なら「ログ」シートを作らない
function loadApp({ config, responses, withLog = true }) {
  const sent = [];
  const alerts = [];
  const menu = [];
  const sheets = { 'フォームの回答 1': makeSheet('フォームの回答 1', responses) };
  if (config) sheets['設定'] = makeSheet('設定', [['キー', '値', '説明'], ...config]);
  if (withLog) sheets['ログ'] = makeSheet('ログ', [['日時', 'レベル', '受付番号', '内容']]);
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    getUrl: () => 'https://example.com/sheet',
    insertSheet: (n) => { sheets[n] = makeSheet(n, []); return sheets[n]; },
  };
  const menuBuilder = {
    addItem: (label, fn) => { menu.push([label, fn]); return menuBuilder; },
    addSeparator: () => { menu.push(['---']); return menuBuilder; },
    addToUi: () => {},
  };
  const context = vm.createContext({
    console, Object, Date, String, Error,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => ({ alert: (m) => alerts.push(m), createMenu: () => menuBuilder }),
      newDataValidation: () => ({ requireValueInList: () => ({ build: () => ({}) }) }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    MailApp: { sendEmail: (...args) => sent.push(args.length === 1 ? args[0] : { to: args[0], subject: args[1], body: args[2] }) },
  });
  for (const f of ['lib.js', 'main.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), context);
  }
  const event = (row, namedValues) => ({ range: sheets['フォームの回答 1'].getRange(row, 1), namedValues });
  const submit = (row, namedValues) => context.onFormSubmit(event(row, namedValues));
  return { sheets, sent, alerts, menu, context, event, submit };
}

const BASE_CONFIG = [
  ['EMAIL_FIELD', 'メールアドレス'],
  ['NAME_FIELD', 'お名前'],
  ['NOTIFY_TO', 'staff@example.com'],
  ['SENDER_NAME', '窓口'],
  ['REPLY_SUBJECT', '受付 {{受付番号}}'],
  ['REPLY_BODY', '{{お名前}} 様\n{{回答一覧}}'],
];
const RESPONSES = [
  ['タイムスタンプ', 'お名前', 'メールアドレス'],
  ['2026/10/13 10:00', '山田', 'yamada@example.com'],
];
const NAMED = { 'タイムスタンプ': ['2026/10/13 10:00'], 'お名前': ['山田'], 'メールアドレス': ['yamada@example.com'] };

test('本番モード: 自動返信と担当者通知を送り、管理列を埋める', () => {
  const app = loadApp({ config: [['DRY_RUN', 'FALSE'], ...BASE_CONFIG], responses: RESPONSES });
  app.submit(2, NAMED);

  const sheet = app.sheets['フォームの回答 1'];
  assert.deepEqual(sheet.data[0].slice(3), ['受付番号', 'ステータス', '処理日時']);
  assert.match(sheet.data[1][3], /^INQ-\d{8}-001$/);
  assert.equal(sheet.data[1][4], '未対応');

  assert.equal(app.sent.length, 2);
  assert.equal(app.sent[0].to, 'yamada@example.com');
  assert.equal(app.sent[0].subject, '受付 ' + sheet.data[1][3]);
  assert.match(app.sent[0].body, /^山田 様\n■ タイムスタンプ/);
  assert.equal(app.sent[0].name, '窓口');
  assert.equal(app.sent[1].to, 'staff@example.com');
});

test('DRY_RUN: メールを送らずログだけ残す', () => {
  const app = loadApp({ config: [['DRY_RUN', 'TRUE'], ...BASE_CONFIG], responses: RESPONSES });
  app.submit(2, NAMED);
  assert.equal(app.sent.length, 0);
  const logs = app.sheets['ログ'].data.slice(1).map((r) => r[3]);
  assert.equal(logs.filter((m) => m.startsWith('[DRY_RUN]')).length, 2);
});

test('同じ行を2回処理しても二重送信しない', () => {
  const app = loadApp({ config: [['DRY_RUN', 'FALSE'], ...BASE_CONFIG], responses: RESPONSES });
  app.submit(2, NAMED);
  app.submit(2, NAMED);
  assert.equal(app.sent.length, 2);
});

test('2件目は受付番号が連番になる', () => {
  const responses = [...RESPONSES, ['2026/10/13 11:00', '佐藤', 'sato@example.com']];
  const app = loadApp({ config: [['DRY_RUN', 'FALSE'], ...BASE_CONFIG], responses });
  app.submit(2, NAMED);
  app.submit(3, { 'お名前': ['佐藤'], 'メールアドレス': ['sato@example.com'] });
  const ids = app.sheets['フォームの回答 1'].data.slice(1).map((r) => r[3]);
  assert.match(ids[1], /-002$/);
});

test('メールアドレスが不正なら自動返信は送らず、担当者通知は送る', () => {
  const app = loadApp({ config: [['DRY_RUN', 'FALSE'], ...BASE_CONFIG], responses: RESPONSES });
  app.submit(2, { 'お名前': ['山田'], 'メールアドレス': ['not-an-email'] });
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].to, 'staff@example.com');
});

test('必須設定が未入力ならエラーをログに残し、何も送らない', () => {
  const config = BASE_CONFIG.filter(([k]) => k !== 'NOTIFY_TO');
  const app = loadApp({ config: [['DRY_RUN', 'FALSE'], ...config], responses: RESPONSES });
  app.submit(2, NAMED);
  assert.equal(app.sent.length, 0);
  const errors = app.sheets['ログ'].data.filter((r) => r[1] === 'ERROR');
  assert.equal(errors.length, 1);
  assert.match(errors[0][3], /NOTIFY_TO/);
});

// ---- handleFormSubmit_(e, config) への分割（docs/specs/selftest.md 3.2） ----
const GIVEN = { DRY_RUN: true, EMAIL_FIELD: 'メールアドレス', NAME_FIELD: 'お名前', NOTIFY_TO: 'notify@example.com',
  SENDER_NAME: '窓口', REPLY_SUBJECT: '受付 {{受付番号}}', REPLY_BODY: '{{お名前}} 様', NOTIFY_SUBJECT: '通知 {{受付番号}}' };

test('handleFormSubmit_: 渡された設定を使い、「設定」シートがなくても受け付ける（DRY_RUN なのでメールは送らない）', () => {
  const app = loadApp({ config: null, responses: RESPONSES });
  app.context.handleFormSubmit_(app.event(2, NAMED), Object.assign({}, GIVEN));
  const sheet = app.sheets['フォームの回答 1'];
  assert.match(sheet.data[1][3], /^INQ-\d{8}-001$/);
  assert.equal(app.sent.length, 0);
  const logs = app.sheets['ログ'].data.slice(1).map((r) => r[3]);
  assert.deepEqual(logs, [
    '[DRY_RUN] 送信予定: yamada@example.com / 受付 ' + sheet.data[1][3],
    '[DRY_RUN] 送信予定: notify@example.com / 通知 ' + sheet.data[1][3],
    '受付処理が完了しました（DRY_RUN: メール未送信）',
  ]);
});

test('handleFormSubmit_: 渡された設定が「設定」シートより優先される（シートが FALSE でも、渡した DRY_RUN = TRUE なら送らない）', () => {
  const app = loadApp({ config: [['DRY_RUN', 'FALSE'], ...BASE_CONFIG], responses: RESPONSES });
  app.context.handleFormSubmit_(app.event(2, NAMED), Object.assign({}, GIVEN));
  assert.equal(app.sent.length, 0);
});

test('onFormSubmit は今どおり「設定」シートを読む。「設定」がなければ ERROR をログに残し、何も送らない', () => {
  const app = loadApp({ config: null, responses: RESPONSES });
  app.submit(2, NAMED);
  assert.equal(app.sent.length, 0);
  const errors = app.sheets['ログ'].data.filter((r) => r[1] === 'ERROR');
  assert.equal(errors.length, 1);
  assert.match(errors[0][3], /「設定」シートがありません/);
});

test('notifyError_: 例外のときは渡された設定で通知を決める（DRY_RUN = TRUE なら送らず、FALSE なら渡した NOTIFY_TO に送る）', () => {
  const broken = (app) => { app.context.ensureManagementColumns_ = () => { throw new Error('わざとの例外'); }; };
  const a = loadApp({ config: [['DRY_RUN', 'FALSE'], ...BASE_CONFIG], responses: RESPONSES });
  broken(a);
  a.context.handleFormSubmit_(a.event(2, NAMED), Object.assign({}, GIVEN));
  assert.equal(a.sent.length, 0, '「設定」シートの FALSE ではなく、渡した TRUE を使う');
  assert.equal(a.sheets['ログ'].data.filter((r) => r[1] === 'ERROR').length, 1);

  const b = loadApp({ config: null, responses: RESPONSES });
  broken(b);
  b.context.handleFormSubmit_(b.event(2, NAMED), Object.assign({}, GIVEN, { DRY_RUN: false }));
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].to, 'notify@example.com');
  assert.match(b.sent[0].subject, /エラーが発生しました/);
});

test('setup: 「ログ」シートを createLogSheet_ で作る（見出し 4 つ）。あれば作り直さない', () => {
  const app = loadApp({ config: [['DRY_RUN', 'TRUE']], responses: RESPONSES, withLog: false });
  app.context.setup();
  assert.deepEqual(app.sheets['ログ'].data[0], ['日時', 'レベル', '受付番号', '内容']);
  app.sheets['ログ'].appendRow(['x', 'INFO', '', '残す']);
  app.context.setup();
  assert.equal(app.sheets['ログ'].data.length, 2);
  assert.equal(app.alerts.length, 2);
});

test('onOpen: selftest.js がなければ今のメニューのまま。runSelfTest があるときだけ「自己テスト（開発用）」を足す', () => {
  const app = loadApp({ config: null, responses: RESPONSES });
  app.context.onOpen();
  assert.deepEqual(app.menu.map((x) => x[0]), ['① 初期設定（シート作成）', '② 自動実行を有効にする', '---', '自動実行を停止する']);
  const withSelfTest = loadApp({ config: null, responses: RESPONSES });
  withSelfTest.context.runSelfTest = () => {};
  withSelfTest.context.onOpen();
  assert.deepEqual(withSelfTest.menu.slice(-2), [['---'], ['自己テスト（開発用）', 'runSelfTest']]);
});
