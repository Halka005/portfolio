/**
 * main.js の結合テスト。
 * SpreadsheetApp・DriveApp・GmailApp などの GAS サービスを簡易的な偽物（モック）に置き換えて、
 * 請求明細の読み込み → 計算 → PDF 作成 → 下書き作成 → 発行履歴 の流れを確認する。
 * 実際の Google 環境での動作は README の「動作確認チェックリスト」で確認する。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeSheet(rows) {
  const data = rows.map((r) => r.slice());
  const cell = (r, c) => (data[r - 1] && data[r - 1][c - 1] !== undefined ? data[r - 1][c - 1] : '');
  const range = (r, c, nr = 1, nc = 1) => {
    const self = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      setValue: (v) => self.setValues([[v]]),
      setValues: (vals) => {
        vals.forEach((rowVals, i) => rowVals.forEach((v, j) => {
          while (data.length < r + i) data.push([]);
          data[r + i - 1][c + j - 1] = v;
        }));
        return self;
      },
    };
    return self;
  };
  return {
    data,
    getRange: range,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(0, ...data.map((r) => r.length)),
    appendRow: (row) => data.push(row.slice()),
  };
}

const CONFIG = {
  ISSUER_NAME: 'サンプル事務所',
  ISSUER_ADDRESS: '東京都',
  BANK_INFO: 'サンプル銀行',
  PAYMENT_TERMS: '翌月末',
  ROUNDING: 'floor',
  FOLDER_ID: '',
  MAIL_SUBJECT: '【請求書】{{請求月}}分 {{請求書番号}}',
  MAIL_BODY: '{{担当者名}} 様 {{請求金額}} 期限 {{支払期限}}',
};

function loadApp({ config = {}, customers, items, history = [] } = {}) {
  const merged = Object.assign({ DRY_RUN: 'FALSE' }, CONFIG, config);
  const sheets = {
    '設定': makeSheet([['キー', '値', '説明'], ...Object.entries(merged).map(([k, v]) => [k, v, ''])]),
    '顧客': makeSheet([['顧客ID', '会社名', '敬称', '担当者名', 'メールアドレス'], ...(customers || [
      ['C001', '株式会社サンプル商事', '御中', '山田 太郎', 'yamada@example.com'],
      ['C002', 'テスト合同会社', '御中', '佐藤 花子', 'sato@example.com'],
    ])]),
    '請求明細': makeSheet([['請求月', '顧客ID', '品目', '数量', '単価', '税率'], ...(items || [
      ['2026-10', 'C001', '保守', 1, 30000, 10],
      ['2026-10', 'C001', '作業', 3, 5000, 10],
      ['2026-10', 'C002', '入力代行', 120, 50, 10],
      ['2026-09', 'C002', '先月分', 1, 9999, 10],
    ])]),
    '発行履歴': makeSheet([['請求月', '顧客ID', '請求書番号', '請求金額', 'PDF', 'Gmail下書き', '作成日時'], ...history]),
    'ログ': makeSheet([['日時', 'レベル', '内容']]),
  };
  const calls = { files: [], drafts: [], folders: [], htmls: [], menu: [], alerts: [] };
  const makeFile = (blob) => ({ getUrl: () => 'https://drive.example/' + blob.name, getId: () => 'f' });
  const folder = { createFile: (blob) => { calls.files.push(blob.name); return makeFile(blob); } };

  const context = vm.createContext({
    console, Object, Date, String, Number, Error, Math,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }),
      getUi: () => {
        const builder = {
          addItem: (label, fn) => { calls.menu.push([label, fn]); return builder; },
          addSeparator: () => { calls.menu.push(['---']); return builder; },
          addToUi: () => {},
        };
        return { createMenu: () => builder, alert: (m) => { calls.alerts.push(m); } };
      },
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      formatDate: () => '2026-10',
      newBlob: (html) => {
        calls.htmls.push(html);
        return { getAs: () => { const b = { name: '' }; b.setName = (n) => { b.name = n; return b; }; return b; } };
      },
    },
    DriveApp: {
      createFile: (blob) => { calls.files.push('MyDrive/' + blob.name); return makeFile(blob); },
      createFolder: (name) => { calls.folders.push(name); return Object.assign({ getId: () => 'NEW_FOLDER', getUrl: () => 'u' }, folder); },
      getFolderById: (id) => { calls.folders.push('id:' + id); return folder; },
    },
    GmailApp: { createDraft: (to, subject, body, opts) => { calls.drafts.push({ to, subject, body, opts }); return {}; } },
  });
  for (const f of ['lib.js', 'main.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), context);
  }
  return { sheets, calls, context, run: (ym) => context.runInvoices(ym, new Date(2026, 9, 31)) };
}

test('本番モード: 顧客ごとに PDF と下書きを作り、発行履歴に残す', () => {
  const app = loadApp();
  const result = app.run('202610');

  assert.equal(result.created, 2);
  assert.deepEqual(app.calls.files, ['INV-202610-001_株式会社サンプル商事.pdf', 'INV-202610-002_テスト合同会社.pdf']);
  assert.deepEqual(app.calls.folders, ['請求書']); // FOLDER_ID が空なので作成

  assert.equal(app.calls.drafts.length, 2);
  const d = app.calls.drafts[0];
  assert.equal(d.to, 'yamada@example.com');
  assert.equal(d.subject, '【請求書】2026-10分 INV-202610-001');
  assert.equal(d.body, '山田 太郎 様 ¥49,500 期限 2026年11月30日'); // (30000+15000)*1.1
  assert.equal(d.opts.attachments.length, 1);

  const history = app.sheets['発行履歴'].data.slice(1);
  assert.deepEqual(history.map((r) => [r[1], r[2], r[3], r[5]]), [
    ['C001', 'INV-202610-001', 49500, '作成済み'],
    ['C002', 'INV-202610-002', 6600, '作成済み'],
  ]);
  // 作成したフォルダの ID を設定シートに書き戻す
  const folderRow = app.sheets['設定'].data.find((r) => r[0] === 'FOLDER_ID');
  assert.equal(folderRow[1], 'NEW_FOLDER');
});

test('2 回実行しても二重発行しない', () => {
  const app = loadApp();
  app.run('202610');
  const second = app.run('202610');
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 2);
  assert.equal(app.calls.drafts.length, 2);
  assert.equal(app.sheets['発行履歴'].data.length, 3);
});

test('番号は発行履歴の続きから振る', () => {
  const app = loadApp({ history: [["'2026-10", 'C009', 'INV-202610-005', 1, '', '', '']] });
  app.run('202610');
  assert.match(app.calls.files[0], /^INV-202610-006_/);
});

test('DRY_RUN: 確認用 PDF だけ作り、下書きと発行履歴は作らない', () => {
  const app = loadApp({ config: { DRY_RUN: 'TRUE' } });
  const result = app.run('202610');
  assert.equal(result.created, 2);
  assert.match(result.message, /お試しモード/);
  assert.deepEqual(app.calls.files, ['MyDrive/[確認用]INV-202610-001_株式会社サンプル商事.pdf', 'MyDrive/[確認用]INV-202610-002_テスト合同会社.pdf']);
  assert.equal(app.calls.drafts.length, 0);
  assert.equal(app.calls.folders.length, 0);
  assert.equal(app.sheets['発行履歴'].data.length, 1);
});

test('明細に不備が 1 行でもあれば、1 枚も作らない', () => {
  const app = loadApp({ items: [
    ['2026-10', 'C001', '保守', 1, 30000, 10],
    ['2026-10', 'C404', '不明な顧客', 1, 100, 10],
  ] });
  const result = app.run('202610');
  assert.equal(result.created, 0);
  assert.match(result.message, /3 行目: 顧客ID「C404」/);
  assert.equal(app.calls.files.length, 0);
  assert.equal(app.calls.drafts.length, 0);
});

test('メールアドレスが不正な顧客は、PDF は作るが下書きは作らない', () => {
  const app = loadApp({ customers: [['C001', 'A社', '御中', '山田', 'not-an-email']], items: [['2026-10', 'C001', '保守', 1, 1000, 10]] });
  app.run('202610');
  assert.equal(app.calls.files.length, 1);
  assert.equal(app.calls.drafts.length, 0);
  assert.equal(app.sheets['発行履歴'].data[1][5], '未作成');
});

test('対象月の明細がなければ何もしない', () => {
  const app = loadApp();
  const result = app.run('202612');
  assert.equal(result.created, 0);
  assert.match(result.message, /2026-12 の請求明細がありません/);
});

test('必須設定が未入力ならエラーを返し、ログに残す', () => {
  const app = loadApp({ config: { BANK_INFO: '' } });
  const result = app.run('202610');
  assert.match(result.message, /BANK_INFO/);
  assert.equal(app.sheets['ログ'].data.filter((r) => r[1] === 'ERROR').length, 1);
});

test('登録番号の形式が不正ならエラー', () => {
  const app = loadApp({ config: { REGISTRATION_NUMBER: 'T123' } });
  assert.match(app.run('202610').message, /登録番号の形式/);
});

test('請求月が日付型（スプレッドシートの自動変換）でも対象にできる', () => {
  const app = loadApp({ items: [[new Date(2026, 9, 1), 'C001', '保守', 1, 1000, 10]] });
  assert.equal(app.run('202610').created, 1);
});

// ---- 自己テストのための分け方（docs/specs/selftest.md 3.2） ----
test('runInvoicesWith_: 設定を渡すと「設定」シートを読まない（なくても動き、FOLDER_ID の書き戻しもない）', () => {
  const app = loadApp();
  delete app.sheets['設定'];
  const config = app.context.parseConfigRows([['DRY_RUN', 'FALSE'], ...Object.entries(CONFIG), ['FOLDER_ID', 'GIVEN']]);
  const result = app.context.runInvoicesWith_('202610', new Date(2026, 9, 31), config);
  assert.equal(result.created, 2, result.message);
  assert.deepEqual(app.calls.folders, ['id:GIVEN']);
  assert.equal(app.sheets['設定'], undefined);
});

test('runInvoicesWith_: 設定が null なら今どおり「設定」シートから読む（runInvoices と同じ）', () => {
  const app = loadApp({ config: { DRY_RUN: 'TRUE' } });
  const result = app.context.runInvoicesWith_('202610', new Date(2026, 9, 31), null);
  assert.equal(result.created, 2);
  assert.match(result.message, /^【お試しモード】/);
  const noConfig = loadApp();
  delete noConfig.sheets['設定'];
  assert.match(noConfig.run('202610').message, /「設定」シートがありません/);
});

test('loadConfig_: 「設定」シートの真偽値のセル（Sheets は TRUE を真偽値で返す）もそのまま読む', () => {
  const app = loadApp({ config: { DRY_RUN: true } });
  const result = app.run('202610');
  assert.match(result.message, /^【お試しモード】/);
  assert.equal(app.calls.drafts.length, 0);
});

test('insertSampleData: sampleData の 2 社と 4 行を、今の月で足す', () => {
  const app = loadApp({ customers: [], items: [] });
  app.context.insertSampleData();
  assert.deepEqual(JSON.parse(JSON.stringify(app.sheets['顧客'].data.slice(1))), JSON.parse(JSON.stringify(app.context.sampleData('2026-10').customers)));
  assert.deepEqual(JSON.parse(JSON.stringify(app.sheets['請求明細'].data.slice(1))), JSON.parse(JSON.stringify(app.context.sampleData('2026-10').items)));
  assert.deepEqual(app.calls.alerts, ['サンプルデータを入れました（請求月: 2026-10）。']);
});

test('onOpen: selftest.js がなければメニューは今のまま（「自己テスト（開発用）」は出ない）', () => {
  const app = loadApp();
  app.context.onOpen();
  assert.deepEqual(app.calls.menu.map((x) => x[0]), ['① 初期設定（シート作成）', 'サンプルデータを入れる', '---', '② 請求書を作成する']);
});
