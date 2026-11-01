/**
 * 自己テスト（src/selftest.js）自体のテスト。仕様 docs/specs/selftest.md 9.2。
 * main.test.js の makeSheet を広げたモックをこのファイルの中に作り、その上で ○ も × も未実施も正しく出ること、
 * 本番のコードや Google の返り値をわざと壊しても偽の ○ にならないこと、メールを 1 通も送らないことを確かめる。
 * Google の上での動き（入力規則の読み方、日付の型、toString など）は、モックでは分からない（README の自己テストで確かめる）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const st = require('../src/selftest.js');
const lib = require('../src/lib.js');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['main.js', 'lib.js', 'selftest.js'];
const T0 = Date.UTC(2026, 9, 18, 1, 2); // 2026-10-18 10:02（日本時間）
const JUDGED = st.SELFTEST_PLAN.filter((p) => p.kind === '判定').map((p) => p.id);
const plain = (v) => JSON.parse(JSON.stringify(v));
const pad = (n) => String(n).padStart(2, '0');
// 本番の formatDateKey(new Date()) と同じ日（Node の地方時）。自己テストの {今日} の正解
const todayKey = () => { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); };

// =====================================================================
// モック
// =====================================================================
/**
 * options:
 *   name: スプレッドシートの名前、sheets: { 名前: 行 }（最初からあるシート）、docLock: getDocumentLock が取れるか、
 *   onGetValues(sheetName, values, r, c): getValues の戻り値を書き換える（Google の返り値のまね）、
 *   dayKey(): Utilities.formatDate の yyyyMMdd の値（既定は今日）、withSelfTest: selftest.js を読むか（既定 true）、
 *   transforms: [[ファイル名, 前, 後]]（読み込む前にソースを書き換えて本番を壊す。監査の壊し方のまね）、
 *   mailFixed: MailApp を書き換えられない（差し替えが効かない）ようにする、quota: 1 日に送れる残りの通数の始め（既定 100）。
 *   calls.mails は本物の MailApp.sendEmail が呼ばれた（＝実際に送った）分だけ。残りの通数は送った分だけ減る
 */
function createGas(options = {}) {
  const o = Object.assign({ name: '自己テスト_受付', sheets: {}, docLock: true, withSelfTest: true, dayKey: todayKey, transforms: [], mailFixed: false, quota: 100 }, options);
  const calls = { alerts: [], mails: [], drafts: 0, flush: 0, menu: [], activated: [], submits: [] };
  let sheetSeq = 0;
  const sheets = [];

  function makeSheet(name, rows = []) {
    const data = rows.map((r) => r.slice());
    const sheet = {
      name,
      id: ++sheetSeq,
      data,
      formats: {},
      backgrounds: {},
      fontColors: {},
      validations: {},
      frozen: 0,
      widths: {},
      bold: {},
      getName: () => sheet.name,
      getSheetId: () => sheet.id,
      getLastRow: () => {
        for (let i = data.length - 1; i >= 0; i--) if ((data[i] || []).some((v) => v !== '' && v !== null && v !== undefined)) return i + 1;
        return 0;
      },
      getLastColumn: () => Math.max(0, ...data.map((r) => (r || []).length)),
      getMaxRows: () => 1000,
      getRange: (r, c, nr = 1, nc = 1) => makeRange(sheet, r, c, nr, nc),
      getDataRange: () => makeRange(sheet, 1, 1, Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn())),
      appendRow: (row) => { data.splice(sheet.getLastRow()); data.push(row.slice()); return sheet; },
      setFrozenRows: (n) => { sheet.frozen = n; return sheet; },
      setColumnWidth: (col, w) => { sheet.widths[col] = w; return sheet; },
      activate: () => { calls.activated.push(sheet.name); return sheet; },
      text: () => {
        const cols = sheet.getLastColumn();
        return data.slice(0, sheet.getLastRow()).map((r) => Array.from({ length: cols }, (_, j) => {
          const v = (r || [])[j];
          return v === undefined || v === null ? '' : String(v);
        }));
      },
    };
    return sheet;
  }

  function makeRange(sheet, r, c, nr, nc) {
    const each = (fn) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fn(r + i, c + j, i, j); };
    const self = {
      getRow: () => r,
      getSheet: () => sheet,
      getValue: () => self.getValues()[0][0],
      getValues: () => {
        const values = Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
          const row = sheet.data[r + i - 1];
          const v = row ? row[c + j - 1] : undefined;
          return v === undefined || v === null ? '' : v;
        }));
        return o.onGetValues ? o.onGetValues(sheet.name, values, r, c) : values;
      },
      setValues: (vals) => {
        if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error('setValues の大きさが範囲と違います（モック）');
        vals.forEach((rowVals, i) => rowVals.forEach((v, j) => {
          while (sheet.data.length < r + i) sheet.data.push([]);
          sheet.data[r + i - 1][c + j - 1] = v;
        }));
        return self;
      },
      setValue: (v) => self.setValues([[v]]),
      setNumberFormat: (f) => { each((y, x) => { sheet.formats[y + ',' + x] = f; }); return self; },
      setBackgrounds: (m) => { each((y, x, i, j) => { sheet.backgrounds[y + ',' + x] = m[i][j]; }); return self; },
      setBackground: (b) => { each((y, x) => { sheet.backgrounds[y + ',' + x] = b; }); return self; },
      setFontColors: (m) => { each((y, x, i, j) => { sheet.fontColors[y + ',' + x] = m[i][j]; }); return self; },
      setFontWeight: (w) => { each((y, x) => { sheet.bold[y + ',' + x] = w; }); return self; },
      setWrap: () => self,
      setDataValidation: (rule) => { each((y, x) => { sheet.validations[y + ',' + x] = rule; }); return self; },
      getDataValidation: () => sheet.validations[r + ',' + c] || null,
    };
    return self;
  }

  Object.entries(o.sheets).forEach(([n, rows]) => sheets.push(makeSheet(n, rows)));
  const ss = {
    getName: () => o.name,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/SheetIdForTest0001/edit',
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    getSheets: () => sheets.slice(),
    insertSheet: (n, index) => {
      if (sheets.some((s) => s.name === n)) throw new Error('同じ名前のシートがあります（モック）: ' + n);
      const s = makeSheet(n);
      if (index === undefined) sheets.push(s);
      else sheets.splice(index, 0, s);
      return s;
    },
    deleteSheet: (s) => {
      const i = sheets.indexOf(s);
      if (i === -1) throw new Error('シートがありません（モック）');
      sheets.splice(i, 1);
    },
  };

  const menuBuilder = {
    addItem: (label, fn) => { calls.menu.push([label, fn]); return menuBuilder; },
    addSeparator: () => { calls.menu.push(['---']); return menuBuilder; },
    addToUi: () => {},
  };
  const context = vm.createContext({
    console: { log() {}, error() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => ({ alert: (m) => { calls.alerts.push(m); }, createMenu: () => menuBuilder }),
      flush: () => { calls.flush++; },
      newDataValidation: () => ({
        requireValueInList: (list, show) => ({ build: () => ({ getCriteriaValues: () => [list.slice(), show] }) }),
      }),
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
      getDocumentLock: () => ({ tryLock: () => o.docLock, releaseLock: () => {} }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      // yyyyMMdd は o.dayKey()（既定は今日。本番の formatDateKey(new Date()) と同じ日）。ほかは日本時間（+9 時間）で
      formatDate: (d, tz, fmt) => {
        if (fmt === 'yyyyMMdd') return o.dayKey();
        const j = new Date(d.getTime() + 9 * 3600 * 1000);
        const ymd = j.getUTCFullYear() + '-' + pad(j.getUTCMonth() + 1) + '-' + pad(j.getUTCDate());
        const hm = pad(j.getUTCHours()) + ':' + pad(j.getUTCMinutes());
        if (fmt === 'yyyy/MM/dd HH:mm:ss') return ymd.replace(/-/g, '/') + ' ' + hm + ':' + pad(j.getUTCSeconds());
        return ymd + ' ' + hm;
      },
    },
    GmailApp: { createDraft: () => { calls.drafts++; return {}; }, sendEmail: () => { calls.mails.push({ to: 'GmailApp' }); } },
  });
  const mailApp = {
    sendEmail: (...args) => { calls.mails.push(args.length === 1 ? args[0] : { to: args[0], subject: args[1] }); },
    getRemainingDailyQuota: () => o.quota - calls.mails.length,
  };
  if (o.mailFixed) Object.defineProperty(context, 'MailApp', { value: mailApp, writable: false, enumerable: true, configurable: false });
  else context.MailApp = mailApp;
  calls.realMailApp = mailApp;
  for (const f of o.withSelfTest ? FILES : ['main.js', 'lib.js']) {
    let code = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const [file, from, to] of o.transforms) {
      if (file !== f) continue;
      assert.ok(code.includes(from), f + ' に「' + from + '」がありません（壊し方を直してください）');
      code = code.split(from).join(to);
    }
    vm.runInContext(code, context, { filename: f });
  }
  return {
    context,
    calls,
    sheet: (n) => ss.getSheetByName(n),
    sheetNames: () => sheets.map((s) => s.name),
    selfTest: () => context.selfTest_(() => T0),
  };
}

function setup(options) {
  const gas = createGas(options);
  return { gas, ctx: gas.context, run: () => gas.selfTest() };
}

function sheetRows(gas) {
  const sheet = gas.sheet('自己テスト');
  return sheet ? sheet.text() : null;
}
function results(gas) {
  const out = {};
  (sheetRows(gas) || []).forEach((r) => { if (r[0] !== '' && r[0] !== '番号') out[r[0]] = { kind: r[1], title: r[2], result: r[3], detail: r[4], seconds: r[5], run: r[6] }; });
  return out;
}
function wrapPlan(gas, id, fn) {
  const p = gas.context.SELFTEST_PLAN.find((x) => x.id === id);
  const orig = p.run;
  p.run = (c) => fn(c, orig);
}
/** handleFormSubmit_ の呼び出しを記録する（行・設定） */
function recordSubmits(s) {
  const seen = [];
  const orig = s.ctx.handleFormSubmit_;
  s.ctx.handleFormSubmit_ = (e, config) => {
    seen.push({ row: e.range.getRow(), named: plain(e.namedValues), dryRun: config && config.DRY_RUN, notifyTo: config && config.NOTIFY_TO, config });
    return orig(e, config);
  };
  return seen;
}
function setCell(gas, id, col, value) {
  const sheet = gas.sheet('自己テスト');
  const rowIndex = sheet.text().findIndex((r) => r[0] === id);
  sheet.getRange(rowIndex + 1, col).setValues([[value]]);
}
const cellOf = (gas, id, col) => sheetRows(gas).find((r) => r[0] === id)[col - 1];
const notAllPass = (s, label) => assert.notEqual(results(s.gas)['0'].result, 'すべて合格', label);
const noMail = (s) => { assert.deepEqual(s.gas.calls.mails, []); assert.equal(s.gas.calls.drafts, 0); };

// =====================================================================
// 全体
// =====================================================================
test('正しいデータ: 全体が「すべて合格」、判定の項目がすべて ○ で、確かめた数が分母と同じ。メールと下書きは 0 回', () => {
  const s = setup();
  const seen = recordSubmits(s);
  const out = s.run();
  assert.equal(out.status, 'done');
  const r = results(s.gas);
  assert.equal(r['0'].result, 'すべて合格', r['0'].detail);
  assert.equal(r['0'].detail, '判定 6 件がすべて ○（自動の項目だけ）。本番のメニューでの確認（M01）と承認画面の文（M02）は、手で書いてから送ってください');
  assert.deepEqual(JUDGED, ['A01', 'A02', 'A03', 'A04', 'A05', 'A06']);
  const counts = { A01: 1, A02: 11, A03: 3, A04: 3, A05: 4, A06: 1 };
  for (const id of JUDGED) {
    assert.equal(r[id].result, '○', id + ': ' + r[id].detail);
    assert.ok(r[id].detail.startsWith('確かめた ' + counts[id] + ' / ' + counts[id]), id + ': ' + r[id].detail);
    assert.equal(r[id].run, '1');
  }
  assert.match(r.A06.detail, /「設定」なし。ないままかだけを確認/);
  // 呼び出し: A02 は 2 行目、A03 は 3 行目、A04 は 2 行目にもう一度、A05 は 4 行目。設定は DRY_RUN = TRUE、通知先は notify@example.com
  assert.deepEqual(seen.map((x) => [x.row, x.dryRun, x.notifyTo]), [[2, true, 'notify@example.com'], [3, true, 'notify@example.com'], [2, true, 'notify@example.com'], [4, true, 'notify@example.com']]);
  assert.equal(new Set(seen.map((x) => x.config)).size, 4, '設定のオブジェクトを呼び出しどうしで共有しない');
  assert.deepEqual(seen[0].named, { 'タイムスタンプ': ['2026/10/18 10:02:00'], 'お名前': ['山田 太郎'], 'メールアドレス': ['yamada@example.com'], 'お問い合わせ内容': ['お見積もりの相談です'] });
  assert.equal(s.ctx.DEFAULT_CONFIG[0][1], 'TRUE');
  // 外部への影響: メールも下書きも 0 回
  noMail(s);
  // シート: 「自己テスト」が先頭。「自己テスト_回答」は 4 行、「ログ」は本番の形で作られる。「設定」は作らない
  assert.deepEqual(s.gas.sheetNames(), ['自己テスト', '自己テスト_回答', 'ログ']);
  const resp = s.gas.sheet('自己テスト_回答').text();
  const today = todayKey();
  assert.deepEqual(resp.map((x) => x.slice(0, 6)), [
    ['タイムスタンプ', 'お名前', 'メールアドレス', 'お問い合わせ内容', '受付番号', 'ステータス'],
    ['2026/10/18 10:02:00', '山田 太郎', 'yamada@example.com', 'お見積もりの相談です', 'INQ-' + today + '-001', '未対応'],
    ['2026/10/18 10:02:00', '佐藤 花子', 'sato@example.com', '資料を送ってください', 'INQ-' + today + '-002', '未対応'],
    ['2026/10/18 10:02:00', '鈴木 一郎', 'not-an-email', '電話で連絡がほしいです', 'INQ-' + today + '-003', '未対応'],
  ]);
  const log = s.gas.sheet('ログ').text();
  assert.deepEqual(log[0], ['日時', 'レベル', '受付番号', '内容']);
  assert.equal(log.length, 1 + 3 + 3 + 1 + 3);
  assert.equal(s.gas.calls.alerts.length, 1);
  assert.match(s.gas.calls.alerts[0], /^自己テストの結果: すべて合格。[\s\S]*M01・M02 を書いてから「自己テスト」シートを送ってください。$/);
  assert.deepEqual(s.gas.calls.activated, ['自己テスト']);
});

test('2 回目に押しても「すべて合格」。「自己テスト_回答」は作り直し（番号は 001 から）、「ログ」は消さずに行を足す', () => {
  const s = setup();
  s.run();
  const logRows = s.gas.sheet('ログ').getLastRow();
  s.run();
  assert.equal(results(s.gas)['0'].result, 'すべて合格');
  assert.equal(s.gas.sheet('ログ').getLastRow(), logRows * 2 - 1);
  assert.equal(s.gas.sheet('自己テスト_回答').text()[1][4], 'INQ-' + todayKey() + '-001');
  noMail(s);
});

test('結果のシート: 18 行。見出しは灰色・太字・固定、書いた範囲はすべて @、M01・M02 の E 列だけ黄色（M03 は白）、× の D 列だけ赤', () => {
  const s = setup();
  s.ctx.SELFTEST_IDS.A03 = 'INQ-{今日}-009'; // わざと違う期待値で × を 1 つ出す
  s.run();
  const sheet = s.gas.sheet('自己テスト');
  const rows = sheet.text();
  assert.equal(rows.length, 18);
  assert.deepEqual(rows.map((r) => r[0]), ['番号', '0', 'A01', 'A02', 'A03', 'A04', 'A05', 'A06', '', 'M01', 'M02', 'M03', '', 'I01', 'I02', 'I03', 'I04', 'I05']);
  assert.deepEqual(rows[0], st.SELFTEST_HEADERS);
  for (let r = 1; r <= 18; r++) for (let c = 1; c <= 7; c++) assert.equal(sheet.formats[r + ',' + c], '@', r + ',' + c);
  for (let c = 1; c <= 7; c++) {
    assert.equal(sheet.backgrounds['1,' + c], '#e0e0e0');
    assert.equal(sheet.bold['1,' + c], 'bold');
  }
  assert.equal(sheet.frozen, 1);
  assert.equal(sheet.backgrounds['10,5'], '#fff8c5');
  assert.equal(sheet.backgrounds['11,5'], '#fff8c5');
  assert.equal(sheet.backgrounds['12,5'], '#ffffff');
  assert.equal(sheet.backgrounds['5,5'], '#ffffff');
  assert.deepEqual(sheet.widths, { 3: 320, 5: 480 });
  assert.equal(rows[4][3], '×');
  assert.equal(sheet.fontColors['5,4'], '#c62828');
  assert.equal(sheet.fontColors['4,4'], '#000000');
  assert.equal(rows[11][4], st.SELFTEST_M03_TEXT);
  assert.equal(cellOf(s.gas, 'I01', 5), '1=2026-10-18 10:02');
  assert.equal(cellOf(s.gas, 'I02', 5), 'SELFTEST_VERSION=' + st.SELFTEST_VERSION + ' / スプレッドシート=自己テスト_受付');
  assert.match(cellOf(s.gas, 'I03', 5), /^コード=[0-9a-f]{8}$/);
  assert.equal(cellOf(s.gas, 'I04', 5), 'なし');
  assert.equal(cellOf(s.gas, 'I05', 5), '送信の関数=差し替えた（4 回とも）');
  // 個人の情報: example.com 以外のメールアドレス・URL がない。= で始まる値がない
  const all = rows.flat().join('\n');
  assert.doesNotMatch(all, /docs\.google\.com|drive\.google\.com|SheetIdForTest/);
  for (const m of all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) assert.match(m, /@example\.com$/);
  assert.ok(rows.flat().every((v) => !v.startsWith('=')));
});

test('名前の確認: 名前が「自己テスト」で始まらないと、何も書かずに文を出して終わる', () => {
  const s = setup({ name: '問い合わせ_本番', sheets: { 'フォームの回答 1': [['依頼者のデータ']] } });
  const before = s.gas.sheet('フォームの回答 1').text();
  const seen = recordSubmits(s);
  assert.equal(s.run().status, 'notTestSpreadsheet');
  assert.deepEqual(s.gas.sheetNames(), ['フォームの回答 1']);
  assert.deepEqual(s.gas.sheet('フォームの回答 1').text(), before);
  assert.deepEqual(s.gas.calls.alerts, [s.ctx.SELFTEST_NAME_MESSAGE]);
  assert.deepEqual(seen, []);
  noMail(s);
});

test('ロック: 自己テストが実行中（getDocumentLock が取れない）なら、何も書かずに終わる', () => {
  const s = setup({ docLock: false });
  assert.equal(s.run().status, 'locked');
  assert.deepEqual(s.gas.sheetNames(), []);
  assert.match(s.gas.calls.alerts[0], /自己テストが実行中です/);
});

test('「自己テスト」シートが自己テストのものでなければ、何も書かずに止まる', () => {
  const s = setup({ sheets: { '自己テスト': [['依頼者', 'のシート']] } });
  assert.equal(s.run().status, 'foreignSheet');
  assert.deepEqual(s.gas.sheetNames(), ['自己テスト']);
  assert.deepEqual(s.gas.sheet('自己テスト').text(), [['依頼者', 'のシート']]);
});

test('M 行の書き込み（推奨 6）: M01・M02 に書き込みがあれば、シートを変えずに止まる。空白だけなら空とみなして作り直す', () => {
  const s = setup();
  s.run();
  setCell(s.gas, 'M01', 5, '(1) ① 初期設定・② 自動実行を有効にする・自動実行を停止する');
  const before = s.gas.sheet('自己テスト').text();
  const names = s.gas.sheetNames();
  const logRows = s.gas.sheet('ログ').getLastRow();
  assert.equal(s.run().status, 'manualWritten');
  assert.deepEqual(s.gas.sheet('自己テスト').text(), before);
  assert.deepEqual(s.gas.sheetNames(), names);
  assert.equal(s.gas.sheet('ログ').getLastRow(), logRows);
  assert.equal(s.gas.calls.alerts[s.gas.calls.alerts.length - 1], s.ctx.SELFTEST_MANUAL_STOP_MESSAGE);
  setCell(s.gas, 'M01', 5, '');
  setCell(s.gas, 'M02', 5, ' 　');
  assert.equal(s.run().status, 'done');
  assert.equal(cellOf(s.gas, 'M02', 5), '');
  assert.equal(results(s.gas)['0'].result, 'すべて合格');
});

const CONFIG_DETAIL = '実施できません: このスプレッドシートに「設定」シートがあるので、流しませんでした。「設定」シートを消してから押してください';

test('「設定」（推奨 8・director 2026-10-19）: 「設定」があれば A02〜A05 は流さずに未実施（「設定」を消してから押す）。読まず、書かず、A06 で全セルを比べて ○。途中で 1 セル変わると A06 が ×（値は詳細に書かない）', () => {
  // 本番の「設定」が DRY_RUN = FALSE で、通知先が実在しうるアドレスでも、本番の処理を呼ばないので送る先がない
  const rows = [['キー', '値', '説明'], ['DRY_RUN', 'FALSE', ''], ['NOTIFY_TO', 'owner@example.com', '']];
  const s = setup({ sheets: { '設定': rows } });
  const seen = recordSubmits(s);
  s.run();
  let r = results(s.gas);
  assert.equal(r.A01.result, '○');
  for (const id of ['A02', 'A03', 'A04', 'A05']) {
    assert.equal(r[id].result, '未実施', id);
    assert.equal(r[id].detail, CONFIG_DETAIL, id);
  }
  assert.equal(r['0'].result, '未完了');
  assert.equal(r.A06.detail, '確かめた 9 / 9');
  assert.deepEqual(s.gas.sheet('設定').text(), rows);
  assert.deepEqual(seen, [], '本番の処理を呼ばない');
  assert.ok(!s.gas.sheetNames().includes('自己テスト_回答'));
  noMail(s);
  // 中身が空の「設定」でも、あるだけで止める（中身は読まない）
  const e = setup({ sheets: { '設定': [] } });
  const seenE = recordSubmits(e);
  e.run();
  assert.equal(results(e.gas).A02.detail, CONFIG_DETAIL);
  assert.deepEqual(seenE, []);
  // 「設定」を消して押し直すと流れる
  const g = setup({ sheets: { '設定': rows } });
  g.run();
  const ssG = g.gas.context.SpreadsheetApp.getActiveSpreadsheet();
  ssG.deleteSheet(ssG.getSheetByName('設定'));
  g.run();
  assert.equal(results(g.gas)['0'].result, 'すべて合格');

  const t = setup({ sheets: { '設定': rows } });
  wrapPlan(t.gas, 'A01', (c, orig) => { orig(c); t.gas.sheet('設定').getRange(3, 2).setValue('changed@example.com'); });
  t.run();
  r = results(t.gas);
  assert.equal(r.A06.result, '×');
  assert.match(r.A06.detail, /^確かめた 9 \/ 9。設定 B3 が変わりました$/);
  assert.doesNotMatch(sheetRows(t.gas).flat().join('\n'), /changed@example\.com/);
  assert.equal(r['0'].result, '不合格');

  // 途中で「設定」ができたら（本番が作るなど）、残りの A02〜A05 は流さない
  const v = setup();
  const seenV = recordSubmits(v);
  wrapPlan(v.gas, 'A02', (c, orig) => { orig(c); v.gas.context.SpreadsheetApp.getActiveSpreadsheet().insertSheet('設定'); });
  v.run();
  r = results(v.gas);
  assert.equal(r.A02.result, '○');
  for (const id of ['A03', 'A04', 'A05']) assert.equal(r[id].detail, CONFIG_DETAIL, id);
  assert.equal(r.A06.result, '×');
  assert.deepEqual(seenV.map((x) => x.row), [2]);

  const u = setup();
  wrapPlan(u.gas, 'A05', (c, orig) => { orig(c); u.gas.context.SpreadsheetApp.getActiveSpreadsheet().insertSheet('設定'); });
  u.run();
  assert.equal(results(u.gas).A06.result, '×');
  assert.match(results(u.gas).A06.detail, /「設定」がなかったのに/);
});

// =====================================================================
// わざと違う結果・本番のコードを壊す（偽の ○ にならない）
// =====================================================================
test('わざと違う結果: nextInquiryId がいつも 001 を返すと A03・A05 が ×、詳細に期待と実際の受付番号。全体は「不合格」', () => {
  const s = setup();
  s.ctx.nextInquiryId = (ids, dateKey) => 'INQ-' + dateKey + '-001';
  s.run();
  const r = results(s.gas);
  const today = todayKey();
  assert.equal(r.A03.result, '×');
  assert.match(r.A03.detail, new RegExp('回答の E3 の受付番号: 期待「INQ-' + today + '-002」実際「INQ-' + today + '-001」'));
  assert.equal(r.A05.result, '×');
  assert.equal(r['0'].result, '不合格');
  assert.match(r['0'].detail, /^× が \d 件（番号: .*A03/);
  noMail(s);
});

test('本番の関数を期待値に使わない（4.5）: formatDateKey を壊すと A02 が ×（今日の日付は自己テスト側で作るため）', () => {
  const s = setup();
  s.ctx.formatDateKey = () => '20000101';
  s.run();
  const r = results(s.gas);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, new RegExp('期待「INQ-' + todayKey() + '-001」実際「INQ-20000101-001」'));
  for (const id of ['A03', 'A05']) assert.equal(r[id].result, '×', id);
  notAllPass(s);
});

test('本番の定数を期待値に使わない（4.5）: STATUS_NEW・STATUS_OPTIONS・COL_ID を変えると A02 が ×', () => {
  const a = setup();
  a.ctx.STATUS_NEW = '新規';
  a.run();
  assert.equal(results(a.gas).A02.result, '×');
  assert.match(results(a.gas).A02.detail, /ステータス: 期待「未対応」実際「新規」/);

  const b = setup();
  b.ctx.STATUS_OPTIONS = ['未対応', '対応中', '完了'];
  b.run();
  assert.equal(results(b.gas).A02.result, '×');
  assert.match(results(b.gas).A02.detail, /入力規則: 期待「未対応・対応中・完了・対応不要」実際「未対応・対応中・完了」/);

  const c = setup();
  c.ctx.COL_ID = '番号';
  c.run();
  assert.equal(results(c.gas).A02.result, '×');
  assert.match(results(c.gas).A02.detail, /E1 の見出し: 期待「受付番号」実際「番号」/);
});

test('本番の文を期待値に使わない（4.5）: 自動返信の件名の初期値や renderTemplate を変えると A02 が ×', () => {
  const a = setup();
  a.ctx.DEFAULT_CONFIG[5][1] = '受付 {{受付番号}}';
  a.run();
  assert.equal(results(a.gas).A02.result, '×');
  assert.match(results(a.gas).A02.detail, /ログの 1 行目: 期待「INFO \[DRY_RUN\] 送信予定: yamada@example\.com \/ 【受付番号 INQ-\d{8}-001】/);

  const b = setup();
  b.ctx.renderTemplate = (t) => String(t);
  b.run();
  assert.equal(results(b.gas).A02.result, '×');
  notAllPass(b);
});

test('壊す: 本番が DRY_RUN を無視して送ると A02 が ×。送信の関数を差し替えているので、実際には 1 通も送らない', () => {
  const s = setup();
  const orig = s.ctx.handleFormSubmit_;
  s.ctx.handleFormSubmit_ = (e, config) => orig(e, Object.assign({}, config, { DRY_RUN: false }));
  s.run();
  const r = results(s.gas);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, /実際「INFO 送信しました: yamada@exa/);
  assert.match(r.A02.detail, /本番の処理がメールの送信（MailApp\.sendEmail）を 2 回呼びました（差し替えていたので送っていません）$/);
  noMail(s);
  assert.equal(s.ctx.MailApp, s.gas.calls.realMailApp, '終わったら本物に戻す');
});

test('壊す: 処理済みの判定が効かない（受付番号を読まない）と A04 が ×（番号が変わる・送信予定が足される）', () => {
  const s = setup();
  wrapPlan(s.gas, 'A04', (c, orig) => {
    const sheet = s.gas.sheet('自己テスト_回答');
    const id = sheet.data[1][4];
    const getRange = sheet.getRange;
    // 2 行目の受付番号のセルだけ、本番から空に見える
    sheet.getRange = (r, col, nr, nc) => { const rg = getRange(r, col, nr, nc); if (r === 2 && col === 5 && !nr) { return Object.assign({}, rg, { getValue: () => '' }); } return rg; };
    try { orig(c); } finally { sheet.getRange = getRange; }
    assert.ok(id);
  });
  s.run();
  const r = results(s.gas);
  assert.equal(r.A04.result, '×');
  assert.match(r.A04.detail, /送信予定の行が 2 行足されました/);
  noMail(s);
});

test('壊す: isValidEmail がいつも真だと A05 が ×（WARN がなく、送信予定が 2 行）', () => {
  const s = setup();
  s.ctx.isValidEmail = () => true;
  s.run();
  const r = results(s.gas);
  assert.equal(r.A05.result, '×');
  assert.match(r.A05.detail, /WARN の「メールアドレスが不正なため自動返信を送りませんでした」で始まる行が 0 行/);
  assert.match(r.A05.detail, /送信予定の行が 2 行/);
  noMail(s);
});

test('A05 の文（任意 6）: WARN の文の後ろにアドレスが付いても ○。文の頭を変えると ×', () => {
  const s = setup();
  const orig = s.ctx.writeLog_;
  s.ctx.writeLog_ = (level, id, message) => orig(level, id, level === 'WARN' ? message.replace('メールアドレスが不正', 'アドレスが不正') : message);
  s.run();
  assert.equal(results(s.gas).A05.result, '×');
  // 正しい本番の文は、後ろに「: not-an-email」が付く
  const t = setup();
  t.run();
  assert.equal(results(t.gas).A05.result, '○');
  assert.ok(t.gas.sheet('ログ').text().some((row) => row[1] === 'WARN' && row[3] === 'メールアドレスが不正なため自動返信を送りませんでした: not-an-email'));
});

test('Google の返り値: 処理日時が日付でない（文字で返る）と A02 が ×。入力規則がないと A02 が ×', () => {
  const a = setup({ onGetValues: (name, values, r) => (name === '自己テスト_回答' && r === 2 ? values.map((row) => row.map((v) => (v && typeof v === 'object' && typeof v.getTime === 'function' ? '2026/10/18' : v))) : values) });
  a.run();
  assert.equal(results(a.gas).A02.result, '×');
  assert.match(results(a.gas).A02.detail, /G2 の処理日時が日付ではありません/);

  const b = setup();
  b.ctx.SpreadsheetApp.newDataValidation = () => ({ requireValueInList: () => ({ build: () => null }) });
  b.run();
  assert.equal(results(b.gas).A02.result, '×');
  assert.match(results(b.gas).A02.detail, /F2 の入力規則: 期待「未対応・対応中・完了・対応不要」実際「なし」/);
});

test('DRY_RUN が FALSE の初期値: A01 が ×、A02〜A05 は流さずに未実施。handleFormSubmit_ を呼ばず、メールと下書きは 0 回', () => {
  const s = setup();
  s.ctx.DEFAULT_CONFIG[0][1] = 'FALSE';
  const seen = recordSubmits(s);
  s.run();
  const r = results(s.gas);
  assert.equal(r.A01.result, '×');
  assert.match(r.A01.detail, /初期値の DRY_RUN が「false」（期待 TRUE）/);
  for (const id of ['A02', 'A03', 'A04', 'A05']) {
    assert.equal(r[id].result, '未実施', id);
    assert.equal(r[id].detail, '実施できません: DRY_RUN が TRUE でないので止めました');
  }
  assert.equal(r.A06.result, '○');
  assert.equal(r['0'].result, '不合格');
  assert.deepEqual(seen, []);
  noMail(s);
  assert.equal(s.gas.sheet('自己テスト_回答'), null);
});

test('二重の守り: 項目の中の設定が DRY_RUN = TRUE でなければ、handleFormSubmit_ を呼ばずに ×（例外）。メールは 0 回', () => {
  const s = setup();
  const seen = recordSubmits(s);
  s.ctx.selfTestDryRunConfig_ = () => Object.assign(s.ctx.selfTestConfig_(), { DRY_RUN: false });
  s.run();
  const r = results(s.gas);
  for (const id of ['A02', 'A03', 'A04', 'A05']) {
    assert.equal(r[id].result, '×', id);
    assert.equal(r[id].detail, '例外: DRY_RUN が TRUE でないので、受付の処理を呼びませんでした');
  }
  assert.deepEqual(seen, []);
  noMail(s);
});

test('本番の中で例外: A02 が ×（ERROR の行）。notifyError_ は渡した設定（DRY_RUN = TRUE）を使うので、エラーの通知も送らない', () => {
  // 「設定」があると A02〜A05 は流さないので、「設定」なしで流す（渡した設定を使うかは main.test.js で確かめる）
  const s = setup();
  s.ctx.ensureManagementColumns_ = () => { throw new Error('わざとの例外'); };
  s.run();
  const r = results(s.gas);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, /^確かめた 11 \/ 11。/);
  assert.ok(s.gas.sheet('ログ').text().some((row) => row[1] === 'ERROR' && row[3].startsWith('Error: わざとの例外')));
  noMail(s);
});

test('確かめた数: writeLog_ が 1 回目だけ書かないと A02 が ×（ログの行の数）', () => {
  const s = setup();
  const orig = s.ctx.writeLog_;
  let n = 0;
  s.ctx.writeLog_ = (level, id, message) => { n++; if (n === 1) return; orig(level, id, message); };
  s.run();
  const r = results(s.gas);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, /（足された行 2 行。期待 3 行）/);
  assert.equal(r.A03.result, '○');
});

test('確かめた数が足りなければ未実施、多ければ ×（項目の関数が check を飛ばす・増やす）', () => {
  const s = setup();
  wrapPlan(s.gas, 'A01', (c) => { c.expect(2); c.check('1 つ目', true); });
  wrapPlan(s.gas, 'A06', (c) => { c.expect(1); c.check('1', true); c.check('2', true); });
  s.run();
  const r = results(s.gas);
  assert.equal(r.A01.result, '未実施');
  assert.equal(r.A01.detail, '実施できません: 確かめた 1 / 2');
  for (const id of ['A02', 'A03', 'A04', 'A05']) assert.equal(r[id].detail, '実施できません: DRY_RUN が TRUE でないので止めました', id);
  assert.equal(r.A06.result, '×');
  assert.equal(r.A06.detail, '自己テストのコードの誤り: 確かめた 2 / 1');
  assert.equal(r['0'].result, '不合格');
});

test('違いのあとの notRun（5 章・版 4）: 違いを 1 つ見つけたあとで実施できなくなっても ×。詳細に違いと理由の両方', () => {
  const s = setup();
  wrapPlan(s.gas, 'A04', (c) => { c.expect(3); c.check('受付番号', false, '受付番号が違う'); c.notRun('実施できません: わざと'); });
  wrapPlan(s.gas, 'A06', (c) => { c.expect(5); c.check('ok', true); c.notRun('実施できません: わざと'); });
  s.run();
  const r = results(s.gas);
  assert.equal(r.A04.result, '×');
  assert.equal(r.A04.detail, '確かめた 1 / 3。受付番号が違う。実施できません: わざと');
  assert.equal(r.A06.result, '未実施');
  assert.equal(r.A06.detail, '実施できません: わざと');
});

test('項目の中で例外: その項目が × で、次の項目は流れる', () => {
  const s = setup();
  wrapPlan(s.gas, 'A03', () => { throw new Error('わざとの例外'); });
  s.run();
  const r = results(s.gas);
  assert.equal(r.A03.result, '×');
  assert.equal(r.A03.detail, '例外: わざとの例外');
  assert.equal(r.A04.result, '○');
  assert.equal(r.A06.result, '○');
  assert.equal(r['0'].result, '不合格');
});

test('日付が変わった（5.3）: 始めと終わりの日付が違うと A02〜A05 は未実施（時間）、全体は「未完了」。最後の文は M01・M02 をまだ書かない', () => {
  let n = 0;
  const s = setup({ dayKey: () => (n++ === 0 ? todayKey() : '29991231') });
  s.run();
  const r = results(s.gas);
  assert.equal(r.A01.result, '○');
  for (const id of ['A02', 'A03', 'A04', 'A05']) {
    assert.equal(r[id].result, '未実施', id);
    assert.equal(r[id].detail, '時間: 日付が変わったので、もう一度押してください');
  }
  assert.equal(r.A06.result, '○');
  assert.equal(r['0'].result, '未完了');
  assert.equal(r['0'].detail, '未実施 4 件。もう一度「自己テスト（開発用）」を押すと最初から実施します');
  assert.match(s.gas.calls.alerts[0], /M01・M02 はまだ書かないでください。$/);
  // A01 が × のときは、日付が変わっても「DRY_RUN が TRUE でない」の理由を残す
  let m = 0;
  const t = setup({ dayKey: () => (m++ === 0 ? todayKey() : '29991231') });
  t.ctx.DEFAULT_CONFIG[0][1] = 'FALSE';
  t.run();
  assert.equal(results(t.gas).A02.detail, '実施できません: DRY_RUN が TRUE でないので止めました');
});

test('「自己テスト」シートへの書き込み自体が失敗すると、alert に出して終わる（○ はどこにも出ない）', () => {
  const s = setup();
  s.ctx.selfTestWrite_ = () => { throw new Error('書けません'); };
  const out = s.run();
  assert.equal(out.status, 'error');
  assert.match(s.gas.calls.alerts[0], /自己テストが止まりました.*書けません/);
  assert.ok(!(sheetRows(s.gas) || []).flat().includes('○'));
});

test('静的: selftest.js に GmailApp などがない。MailApp に触るのは selfTestWithoutMail_ だけで、そこでも本物の sendEmail は呼ばない。期待値と判定に本番の関数・定数を使わない（4.5）', () => {
  const source = fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf8');
  for (const w of ['GmailApp', 'UrlFetchApp', 'createDraft', 'ScriptApp']) {
    assert.ok(!source.includes(w), 'selftest.js に ' + w);
  }
  // selfTestWithoutMail_ の本文と、コメントの行と、文字列を除いたコードに MailApp・sendEmail がない
  const start = source.indexOf('function selfTestWithoutMail_(');
  const end = source.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start);
  const guard = source.slice(start, end);
  const rest = (source.slice(0, start) + source.slice(end)).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join('\n').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  for (const w of ['MailApp', 'sendEmail']) assert.ok(!rest.includes(w), 'selfTestWithoutMail_ の外に ' + w);
  // 差し替えの中: sendEmail は代わりの関数の名前としてだけ。本物の sendEmail を呼ばない
  assert.doesNotMatch(guard, /\.sendEmail\b/);
  assert.equal((guard.match(/sendEmail/g) || []).length, 1);
  assert.match(guard, /finally \{\n\s*try \{ globalThis\.MailApp = real; \}/);
  // コメントの行と、指紋の一覧の行（'名前',）を除いたコード
  const code = source.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l) && !/^\s*'[A-Za-z0-9_$]+',$/.test(l)).join('\n');
  for (const w of ['formatDateKey', 'nextInquiryId', 'renderTemplate', 'formatAnswers', 'flattenNamedValues', 'isValidEmail', 'missingConfigKeys',
    'STATUS_OPTIONS', 'STATUS_NEW', 'COL_ID', 'COL_STATUS', 'COL_PROCESSED_AT', 'SHEET_LOG', 'SHEET_CONFIG', 'REQUIRED_KEYS',
    'ensureManagementColumns_', 'issueInquiryId_', 'sendMail_', 'writeLog_', 'notifyError_', 'loadConfig_', 'onFormSubmit']) {
    assert.ok(!new RegExp('(^|[^A-Za-z0-9_$])' + w + '([^A-Za-z0-9_$]|$)').test(code), 'selftest.js に ' + w);
  }
  // 本番の名前で使うのは、入力（DEFAULT_CONFIG・parseConfig）、準備（createLogSheet_）、確かめる相手（handleFormSubmit_）だけ
  for (const [w, n] of [['DEFAULT_CONFIG', 1], ['parseConfig', 1], ['createLogSheet_', 1], ['handleFormSubmit_', 1]]) {
    assert.equal((code.match(new RegExp('(^|[^A-Za-z0-9_$])' + w + '\\(|(^|[^A-Za-z0-9_$])' + w + '\\.', 'g')) || []).length, n, w);
  }
});

// =====================================================================
// 自己テスト側の値と本番の一致（4.5）。本番の決まりを変えたら、ここで落ちて両方を見直す
// =====================================================================
test('自己テスト側の値が、正しい本番と同じ: 見出し・ステータス・ログの文・受付番号・今日の日付', () => {
  const gas = createGas();
  const c = gas.context;
  assert.deepEqual(st.SELFTEST_MANAGEMENT_HEADERS, [c.COL_ID, c.COL_STATUS, c.COL_PROCESSED_AT]);
  assert.equal(st.SELFTEST_STATUS_NEW, c.STATUS_NEW);
  assert.deepEqual(st.SELFTEST_STATUS_OPTIONS, plain(c.STATUS_OPTIONS));
  // 受付番号と件名を本番の関数で作り、自己テストに書いた文と同じか
  const today = lib.formatDateKey(new Date());
  assert.equal(today, todayKey());
  const ids = [];
  for (const [id, n] of [['A02', 1], ['A03', 2], ['A05', 3]]) {
    const want = lib.nextInquiryId(ids, today);
    assert.equal(st.selfTestExpand_(st.SELFTEST_IDS[id], today), want, id);
    assert.ok(want.endsWith('-00' + n));
    ids.push(want);
  }
  const config = lib.parseConfig(c.DEFAULT_CONFIG.map((r) => [r[0], r[1]]));
  const line = (p, id) => {
    const vars = { 'お名前': p.name, '受付番号': id };
    return [
      ['INFO', '[DRY_RUN] 送信予定: ' + p.email + ' / ' + lib.renderTemplate(config.REPLY_SUBJECT, vars)],
      ['INFO', '[DRY_RUN] 送信予定: notify@example.com / ' + lib.renderTemplate(config.NOTIFY_SUBJECT, vars)],
      ['INFO', '受付処理が完了しました（DRY_RUN: メール未送信）'],
    ];
  };
  const expand = (rows) => rows.map((r) => [r[0], st.selfTestExpand_(r[1], today)]);
  assert.deepEqual(expand(st.SELFTEST_LOGS.A02), line(st.SELFTEST_PEOPLE.A02, ids[0]));
  assert.deepEqual(expand(st.SELFTEST_LOGS.A03), line(st.SELFTEST_PEOPLE.A03, ids[1]));
  assert.equal(st.selfTestExpand_(st.SELFTEST_A05_NOTIFY, today), line(st.SELFTEST_PEOPLE.A05, ids[2])[1][1]);
  // A04・A05 の文は main.js の文と同じ（本番のソースに含まれる）
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.ok(main.includes("'行 ' + row + ' は処理済みのためスキップしました'"));
  assert.equal(st.SELFTEST_LOGS.A04[0][1], '行 ' + st.SELFTEST_PEOPLE.A02.row + ' は処理済みのためスキップしました');
  assert.ok(main.includes("'" + st.SELFTEST_A05_WARN + ": ' + email"));
  assert.equal(lib.isValidEmail(st.SELFTEST_PEOPLE.A05.email), false);
  assert.ok([st.SELFTEST_PEOPLE.A02, st.SELFTEST_PEOPLE.A03].every((p) => lib.isValidEmail(p.email) && p.email.endsWith('@example.com')));
});

// =====================================================================
// 純粋関数
// =====================================================================
test('columnLetter: 1 → A、26 → Z、27 → AA', () => {
  assert.equal(st.columnLetter(1), 'A');
  assert.equal(st.columnLetter(26), 'Z');
  assert.equal(st.columnLetter(27), 'AA');
  assert.equal(st.columnLetter(53), 'BA');
});

test('compareTables: 一致・セルの違い・行と列の数の違い', () => {
  assert.deepEqual(plain(st.compareTables([['a', 'b'], ['c', 'd']], [['a', 'b'], ['c', 'd']])), { expectedCount: 4, compared: 4, diffs: [] });
  const r = st.compareTables([['a', 'b'], ['c', 'd']], [['a', 'x']], { name: '設定' });
  assert.equal(r.compared, 2);
  assert.deepEqual(plain(r.diffs), [
    { cell: '設定 行の数', expected: '2', actual: '1' },
    { cell: '設定 B1', expected: 'b', actual: 'x' },
  ]);
  assert.deepEqual(plain(st.compareTables([['a', 'b']], [['a']]).diffs), [{ cell: '1 行目の列の数', expected: '2', actual: '1' }]);
  assert.equal(st.compareTables([], []).expectedCount, 0);
});

test('itemResult: 5 章の冒頭の 5 つの決まり', () => {
  assert.deepEqual(plain(st.itemResult(2, [{ name: 'a', ok: true }, { name: 'b', ok: true }])), { result: '○', detail: '確かめた 2 / 2' });
  assert.deepEqual(plain(st.itemResult(0, [])), { result: '未実施', detail: '実施できません: 確かめる数が 0 です' });
  assert.deepEqual(plain(st.itemResult(3, [{ name: 'a', ok: true }])), { result: '未実施', detail: '実施できません: 確かめた 1 / 3' });
  assert.deepEqual(plain(st.itemResult(3, [{ name: 'a', ok: false, detail: '違う' }])), { result: '×', detail: '確かめた 1 / 3。違う' });
  assert.equal(st.itemResult(1, [{ name: 'a', ok: true }, { name: 'b', ok: true }]).detail, '自己テストのコードの誤り: 確かめた 2 / 1');
  assert.equal(st.itemResult(3, [{ name: 'a', ok: false, count: 3, detail: 'まとめて' }]).detail, '確かめた 3 / 3。まとめて');
});

test('formatDiffs: 3 か所まで、ほかは「ほか n か所」、1 か所 120 文字まで、改行は \\n', () => {
  const d = [1, 2, 3, 4, 5].map((i) => ({ text: '違い' + i }));
  assert.equal(st.formatDiffs(d), '違い1。違い2。違い3。ほか 2 か所');
  assert.equal(st.formatDiffs([{ text: 'x'.repeat(130) }]).length, 120);
  assert.equal(st.formatDiffs([{ cell: 'A1', expected: 'a\nb', actual: 'c' }]), 'A1: 期待「a\\nb」実際「c」');
});

test('overallResult: plan が空・結果が足りない・plan にない番号は「すべて合格」にしない。未実施の理由で文が分かれる（続きはないので「最初から」）', () => {
  const ok = { result: '○', detail: '' };
  assert.equal(st.overallResult(['A01'], { A01: ok }).result, 'すべて合格');
  assert.equal(st.overallResult([], {}).result, '不合格');
  assert.match(st.overallResult(['A01', 'A02'], { A01: ok }).detail, /結果のない番号があります: A02/);
  assert.match(st.overallResult(['A01'], { A01: ok, A09: ok }).detail, /予定にない番号の結果があります: A09/);
  assert.match(st.overallResult(['A01'], { A01: { result: '記録' } }).detail, /結果の値が違います/);
  assert.deepEqual(plain(st.overallResult(['A01', 'A02'], { A01: { result: '×' }, A02: { result: '実行中' } })), { result: '不合格', detail: '× が 1 件（番号: A01）。未実施 1 件は、もう一度押すと最初から実施します' });
  assert.equal(st.overallResult(['A01'], { A01: { result: '未実施', detail: '時間: まだ実施していません' } }).detail, '未実施 1 件。もう一度「自己テスト（開発用）」を押すと最初から実施します');
  assert.equal(st.overallResult(['A01', 'A02'], { A01: { result: '未実施', detail: '時間: まだ実施していません' }, A02: { result: '未実施', detail: '実施できません: x' } }).detail,
    '未実施 2 件のうち 1 件は、押し直しても実施できません（例: A02 は「x」）。この画面を送ってください');
});

test('selfTestFinalMessage_: 「未完了」のときだけ M01・M02 をまだ書かない文。個人の情報は伏せる', () => {
  assert.equal(st.selfTestFinalMessage_({ result: '未完了', detail: 'x' }), '自己テストの結果: 未完了。x\nM01・M02 はまだ書かないでください。');
  assert.equal(st.selfTestFinalMessage_({ result: '不合格', detail: 'a@example.org' }), '自己テストの結果: 不合格。（メールアドレスは伏せました）\nM01・M02 を書いてから「自己テスト」シートを送ってください。');
});

test('buildSelfTestValues: 7 列の文字。M03 の E 列は決まった文、M01・M02 は渡した値。example.com 以外のメールアドレスと URL は伏せる', () => {
  const rows = st.buildSelfTestValues(
    [{ id: '0', kind: '全体', title: '全体の判定', result: '○', detail: 'a@example.org と b@example.com と https://docs.google.com/x', seconds: 1.25, run: 1 }],
    [{ id: 'M01', title: 'm1', detail: '書いた' }, { id: 'M02', title: 'm2', detail: '' }, { id: 'M03', title: 'm3', detail: 'x' }],
    st.selfTestInfoRows_('2026-10-18 10:02', 'v', '自己テスト_受付', 'abcd1234'),
  );
  assert.ok(rows.every((r) => r.length === 7 && r.every((v) => typeof v === 'string')));
  assert.equal(rows[1][4], '（メールアドレスは伏せました） と b@example.com と （URL は伏せました）');
  assert.equal(rows[1][5], '1.3');
  assert.equal(rows[3][4], '書いた');
  assert.equal(rows[5][4], st.SELFTEST_M03_TEXT);
  assert.deepEqual(rows.slice(7).map((r) => [r[0], r[4]]), [['I01', '1=2026-10-18 10:02'], ['I02', 'SELFTEST_VERSION=v / スプレッドシート=自己テスト_受付'], ['I03', 'コード=abcd1234'], ['I04', 'なし'], ['I05', '送信の関数=呼んでいない']]);
});

test('selfTestExpand_: {今日} を置き換える（何か所でも）', () => {
  assert.equal(st.selfTestExpand_('INQ-{今日}-001 / {今日}', '20261019'), 'INQ-20261019-001 / 20261019');
  assert.equal(st.selfTestExpand_('なし', '20261019'), 'なし');
});

test('codeFingerprint: 同じ入力で同じ 8 桁の 16 進、1 文字違えば違う値', () => {
  const a = st.codeFingerprint(['abc', 'def']);
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(st.codeFingerprint(['abc', 'def']), a);
  assert.notEqual(st.codeFingerprint(['abc', 'deg']), a);
  assert.notEqual(st.codeFingerprint(['ab', 'cdef']), a);
  assert.equal(st.codeFingerprint([]), '811c9dc5');
});

test('fingerprintSources（8.3 の 3・4）: ok が真。関数の本文・var の値・SELFTEST_PLAN の run の差し替えで指紋が変わる。toString がソースを返さない・引けない関数・undefined の var なら ok が偽', () => {
  const gas = createGas();
  const c = gas.context;
  const lookup = (n) => c[n];
  const printOf = () => st.codeFingerprint(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, lookup).sources);
  const base = st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, lookup);
  assert.equal(base.ok, true);
  let print = printOf();
  vm.runInContext(c.nextInquiryId.toString().replace('max + 1', 'max + 1 + 0'), c);
  assert.notEqual(printOf(), print);
  print = printOf();
  c.SELFTEST_IDS.A03 = 'INQ-{今日}-009';
  assert.notEqual(printOf(), print);
  print = printOf();
  c.SELFTEST_PLAN.find((p) => p.id === 'A04').run = c.selfTestA02_;
  assert.notEqual(printOf(), print);

  const native = (n) => { const v = c[n]; if (typeof v !== 'function') return v; const f = function () {}; f.toString = () => 'function () { [native code] }'; return f; };
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, native).ok, false);
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, (n) => (n === 'handleFormSubmit_' ? undefined : c[n])).ok, false);
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, (n) => (n === 'DEFAULT_CONFIG' ? undefined : c[n])).ok, false);
  assert.equal(st.fingerprintSources(['a'], [], () => { throw new Error('x'); }).ok, false);
});

test('fingerprintSources（8.3 の 4）: 1 つの関数を引けないと I03 が「コード=取れません」（判定は変えない）', () => {
  const s = setup();
  s.ctx.formatAnswers = 1;
  s.ctx.SELFTEST_FINGERPRINT_FUNCS.push('noSuchFunction');
  s.run();
  assert.equal(cellOf(s.gas, 'I03', 5), 'コード=取れません');
});

// =====================================================================
// 指紋の一覧・SELFTEST_PLAN・メニュー
// =====================================================================
function topLevel(source, re) {
  const out = [];
  source.split(/\r\n|\r|\n/).forEach((line) => { const m = re.exec(line); if (m) out.push(m[1]); });
  return out;
}
const sources = () => FILES.map((f) => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]);
const diffNames = (want, have) => ({ 足りない: want.filter((n) => !have.includes(n)), 多い: have.filter((n) => !want.includes(n)) });

test('指紋の一覧（8.3 の 1）: 3 つのファイルの行頭の function と var が、SELFTEST_FINGERPRINT_FUNCS・VARS とちょうど同じで、名前の順。var 名前 = function の行がない', () => {
  const funcs = [];
  const vars = [];
  for (const [f, s] of sources()) {
    topLevel(s, /^function ([A-Za-z0-9_$]+)\(/).forEach((n) => funcs.push(n));
    topLevel(s, /^var ([A-Za-z0-9_$]+)/).forEach((n) => vars.push(n));
    assert.ok(!/^var [A-Za-z0-9_$]+ = function/m.test(s), f + ' に var 名前 = function の行があります');
  }
  const sorted = (a) => a.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  assert.equal(new Set(funcs).size, funcs.length, '関数の名前が重なっています');
  assert.equal(new Set(st.SELFTEST_FINGERPRINT_FUNCS).size, st.SELFTEST_FINGERPRINT_FUNCS.length, '一覧に重複があります');
  assert.equal(new Set(st.SELFTEST_FINGERPRINT_VARS).size, st.SELFTEST_FINGERPRINT_VARS.length, '一覧に重複があります');
  assert.deepEqual(diffNames(funcs, st.SELFTEST_FINGERPRINT_FUNCS), { 足りない: [], 多い: [] }, 'SELFTEST_FINGERPRINT_FUNCS を直してください');
  assert.deepEqual(diffNames(vars, st.SELFTEST_FINGERPRINT_VARS), { 足りない: [], 多い: [] }, 'SELFTEST_FINGERPRINT_VARS を直してください');
  assert.deepEqual(st.SELFTEST_FINGERPRINT_FUNCS, sorted(st.SELFTEST_FINGERPRINT_FUNCS));
  assert.deepEqual(st.SELFTEST_FINGERPRINT_VARS, sorted(st.SELFTEST_FINGERPRINT_VARS));
  assert.ok(st.SELFTEST_FINGERPRINT_FUNCS.includes('handleFormSubmit_') && st.SELFTEST_FINGERPRINT_FUNCS.includes('nextInquiryId') && st.SELFTEST_FINGERPRINT_FUNCS.includes('selfTestA05_'));
  assert.ok(st.SELFTEST_FINGERPRINT_VARS.includes('DEFAULT_CONFIG') && st.SELFTEST_FINGERPRINT_VARS.includes('SELFTEST_PLAN') && st.SELFTEST_FINGERPRINT_VARS.includes('SELFTEST_LOGS'));
});

test('指紋の一覧（8.3 の 2）: 同じ最上位の名前が 2 つのファイルにない（GAS ではあとのファイルが上書きするため）', () => {
  const names = sources().map(([f, s]) => {
    const context = vm.createContext({});
    vm.runInContext(s, context, { filename: f });
    return [f, Object.keys(context)];
  });
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      assert.deepEqual(names[i][1].filter((n) => names[j][1].includes(n)), [], names[i][0] + ' と ' + names[j][0]);
    }
  }
});

test('selftest.js は最上位で他のファイルの名前を使わない（どの順で読んでも、GAS のサービスがなくても読み込める）', () => {
  const context = vm.createContext({});
  assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf8'), context));
  assert.equal(typeof context.runSelfTest, 'function');
});

test('SELFTEST_PLAN: A01〜A06 の順。A02〜A05 は A01 が前提で、日付が変わったら未実施。入力のメールアドレスは @example.com か不正な文字だけ', () => {
  assert.deepEqual(st.SELFTEST_PLAN.map((x) => x.id), ['A01', 'A02', 'A03', 'A04', 'A05', 'A06']);
  assert.ok(st.SELFTEST_PLAN.every((x) => x.kind === '判定' && typeof x.run === 'function'));
  const p = Object.fromEntries(st.SELFTEST_PLAN.map((x) => [x.id, x]));
  for (const id of ['A02', 'A03', 'A04', 'A05']) {
    assert.equal(p[id].needs, 'A01');
    assert.equal(p[id].dated, true);
  }
  assert.equal(p.A01.needs, undefined);
  assert.equal(p.A06.needs, undefined);
  assert.deepEqual(Object.values(st.SELFTEST_PEOPLE).map((x) => x.email), ['yamada@example.com', 'sato@example.com', 'not-an-email']);
  assert.deepEqual(st.SELFTEST_MANUAL.map((m) => m.id), ['M01', 'M02', 'M03']);
});

test('メニュー: selftest.js を読んだときだけ「自己テスト（開発用）」が足される', () => {
  const s = setup();
  s.ctx.onOpen();
  assert.deepEqual(s.gas.calls.menu.map((x) => x[0]), ['① 初期設定（シート作成）', '② 自動実行を有効にする', '---', '自動実行を停止する', '---', '自己テスト（開発用）']);
  assert.equal(s.gas.calls.menu[5][1], 'runSelfTest');
  const p = createGas({ withSelfTest: false });
  p.context.onOpen();
  assert.deepEqual(p.calls.menu.map((x) => x[0]), ['① 初期設定（シート作成）', '② 自動実行を有効にする', '---', '自動実行を停止する']);
});

// =====================================================================
// tester が足した壊し方（docs/reviews/selftest-inquiry-test.md）
// =====================================================================
/** main.js の関数のソースの一部を書き換えて、本番のコードを壊す（ありそうな書き換えのまね） */
function breakSource(s, name, from, to) {
  const src = s.ctx[name].toString();
  assert.ok(src.includes(from), name + ' に「' + from + '」がありません（壊し方を直してください）');
  vm.runInContext(src.replace(from, to), s.ctx);
}
/** 「設定」の初期値の行（① 初期設定のあと）に、値を上書きしたもの */
function configRows(s, over) {
  return [['キー', '値', '説明']].concat(s.ctx.DEFAULT_CONFIG.map((r) => [r[0], Object.prototype.hasOwnProperty.call(over, r[0]) ? over[r[0]] : r[1], r[2]]));
}
const SENT_DETAIL = '実施できません: 本番の処理がメールを送った（または送ろうとした）ので、残りは流しませんでした';

test('壊す（tester）: 本番の DRY_RUN の判定を `=== \'TRUE\'` に壊すと A02 が ×。A02 で止まり、A03〜A05 は流さない（未実施）。差し替えているので実際には送らない', () => {
  const s = setup();
  breakSource(s, 'handleFormSubmit_', 'config.DRY_RUN !== false', "config.DRY_RUN === 'TRUE'");
  const seen = recordSubmits(s);
  s.run();
  const r = results(s.gas);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, /実際「INFO 送信しました: yamada@exa/);
  for (const id of ['A03', 'A04', 'A05']) {
    assert.equal(r[id].result, '未実施', id);
    assert.equal(r[id].detail, SENT_DETAIL, id);
  }
  assert.equal(r.A06.result, '○');
  assert.equal(r['0'].result, '不合格');
  assert.deepEqual(seen.map((x) => x.row), [2], 'A02 のあとは本番の処理を呼ばない');
  noMail(s);
});

test('壊す（tester）: メールを送ったあとに日付が変わっても、A02 の × は未実施に戻さない（送ったことを隠さない）', () => {
  let n = 0;
  const s = setup({ dayKey: () => (n++ === 0 ? todayKey() : '29991231') });
  breakSource(s, 'handleFormSubmit_', 'config.DRY_RUN !== false', "config.DRY_RUN === 'TRUE'");
  s.run();
  const r = results(s.gas);
  assert.equal(r.A02.result, '×');
  for (const id of ['A03', 'A04', 'A05']) assert.equal(r[id].detail, SENT_DETAIL, id);
  assert.equal(r['0'].result, '不合格');
});

test('壊す（engineer の依頼・director 2026-10-19）: handleFormSubmit_ も notifyError_ も渡した設定を使わず「設定」を読む。「設定」がなければ A02〜A05 が ×、エラーの通知を含めてメールは 0 回', () => {
  // 「設定」がないので loadConfig_ が例外 → ERROR → notifyError_ も「設定」を読もうとして例外（握りつぶす）→ 送らない
  const a = setup();
  breakSource(a, 'handleFormSubmit_', 'given || loadConfig_()', 'loadConfig_()');
  breakSource(a, 'notifyError_', 'given || loadConfig_()', 'loadConfig_()');
  const seen = recordSubmits(a);
  a.run();
  let r = results(a.gas);
  for (const id of ['A02', 'A03', 'A04', 'A05']) assert.equal(r[id].result, '×', id);
  assert.equal(seen.length, 4, 'A02〜A05 で本番の処理を 4 回呼ぶ（どれも例外 → notifyError_ を通る）');
  assert.equal(a.gas.sheet('ログ').text().filter((row) => row[1] === 'ERROR' && row[3].startsWith('Error: 「設定」シートがありません')).length, 4);
  assert.equal(r.A06.result, '○');
  assert.equal(r['0'].result, '不合格');
  noMail(a);

  // handleFormSubmit_ は渡した設定を使うが、本番の中で例外になり、notifyError_ だけが「設定」を読む → 送らない
  const b = setup();
  breakSource(b, 'notifyError_', 'given || loadConfig_()', 'loadConfig_()');
  b.ctx.ensureManagementColumns_ = () => { throw new Error('わざとの例外'); };
  b.run();
  r = results(b.gas);
  for (const id of ['A02', 'A03', 'A04', 'A05']) assert.equal(r[id].result, '×', id);
  assert.equal(r['0'].result, '不合格');
  noMail(b);
});

test('壊す（engineer の依頼・director 2026-10-19）: 同じ壊し方で「設定」があれば（初期値のまま・DRY_RUN = FALSE で実在しうる宛先・自己テストと同じ）、A02〜A05 は流さずに未実施。本番の処理を呼ばず、メールは 0 回', () => {
  const variants = [
    ['初期値のまま', {}],
    ['DRY_RUN = FALSE', { DRY_RUN: 'FALSE', NOTIFY_TO: 'owner@example.com' }],
    ['自己テストと同じ', { NOTIFY_TO: 'notify@example.com' }],
  ];
  for (const [label, over] of variants) {
    const s = setup({ sheets: { '設定': [] } });
    s.gas.sheet('設定').data.push(...configRows(s, over));
    breakSource(s, 'handleFormSubmit_', 'given || loadConfig_()', 'loadConfig_()');
    breakSource(s, 'notifyError_', 'given || loadConfig_()', 'loadConfig_()');
    const seen = recordSubmits(s);
    s.run();
    const r = results(s.gas);
    for (const id of ['A02', 'A03', 'A04', 'A05']) {
      assert.equal(r[id].result, '未実施', label + ' ' + id);
      assert.equal(r[id].detail, CONFIG_DETAIL, label + ' ' + id);
    }
    assert.equal(r.A06.result, '○', label);
    assert.equal(r['0'].result, '未完了', label);
    assert.deepEqual(seen, [], label);
    noMail(s);
    assert.doesNotMatch(sheetRows(s.gas).flat().join('\n'), /owner@example\.com/, label);
  }
});

test('日付が変わった（director 2026-10-19）: すでに出た × は、どの項目でも残す（詳細に日付が変わったことを足す）。まだ × が出ていない項目だけ未実施（時間）。全体は「不合格」', () => {
  let n = 0;
  const s = setup({ dayKey: () => (n++ === 0 ? todayKey() : '29991231') });
  s.ctx.STATUS_NEW = '新規';
  s.run();
  let r = results(s.gas);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, /^確かめた 11 \/ 11。回答の F2 のステータス: 期待「未対応」実際「新規」/);
  assert.match(r.A02.detail, /。途中で日付が変わりました。日付のせいの × かもしれないので、もう一度押してください$/);
  for (const id of ['A03', 'A04', 'A05']) {
    assert.equal(r[id].result, '未実施', id);
    assert.equal(r[id].detail, '時間: 日付が変わったので、もう一度押してください', id);
  }
  assert.equal(r['0'].result, '不合格');
  assert.match(r['0'].detail, /^× が 1 件（番号: A02）。未実施 3 件は、もう一度押すと最初から実施します$/);

  // A03〜A05 のどの項目の × でも残す（本番の処理は流したうえで、違いを 1 つ足す）
  for (const id of ['A03', 'A04', 'A05']) {
    let m = 0;
    const t = setup({ dayKey: () => (m++ === 0 ? todayKey() : '29991231') });
    wrapPlan(t.gas, id, (c, orig) => { orig(c); c.expect(1); c.check('わざと', false, 'わざとの違い'); });
    t.run();
    r = results(t.gas);
    for (const other of ['A02', 'A03', 'A04', 'A05']) {
      if (other === id) {
        assert.equal(r[other].result, '×', id);
        assert.match(r[other].detail, /わざとの違い。途中で日付が変わりました/, id);
      } else {
        assert.equal(r[other].result, '未実施', id + ' の回の ' + other);
      }
    }
    assert.equal(r['0'].result, '不合格', id);
  }
});

test('日付が変わった（tester）: 始めの日付だけが違う（今日の日付を作ったあと、本番が呼ばれる前に日付が変わった）ときも、A02〜A05 は ○ にならない', () => {
  // 1 回目（始め）だけ前の日、2 回目（終わり）は今日。本番の受付番号は今日の日付
  let n = 0;
  const s = setup({ dayKey: () => (n++ === 0 ? '20000101' : todayKey()) });
  s.run();
  const r = results(s.gas);
  for (const id of ['A02', 'A03', 'A04', 'A05']) assert.notEqual(r[id].result, '○', id);
  notAllPass(s);
});

/** getRange の戻り値の一部の関数だけを差し替える（行と列は問わない） */
function wrapRange(getRange, over) {
  return (...args) => Object.assign({}, getRange(...args), over);
}

test('入力規則が読めない（tester）: getDataValidation が例外・選択肢が範囲・順番が違う・選択肢が 1 つ多い・空だと、A02 が ×', () => {
  const variants = [
    ['例外', { getDataValidation: () => { throw new Error('読めません'); } }, /例外: 読めません/],
    ['範囲', { getDataValidation: () => ({ getCriteriaValues: () => [{ getA1Notation: () => 'Z1:Z4' }, true] }) }, /入力規則: 期待「未対応・対応中・完了・対応不要」実際「選択肢を読めません」/],
    ['順番', { getDataValidation: () => ({ getCriteriaValues: () => [['対応中', '未対応', '完了', '対応不要'], true] }) }, /実際「対応中・未対応・完了・対応不要」/],
    ['1 つ多い', { getDataValidation: () => ({ getCriteriaValues: () => [['未対応', '対応中', '完了', '対応不要', '保留'], true] }) }, /実際「未対応・対応中・完了・対応不要・保留」/],
    ['空の配列', { getDataValidation: () => ({ getCriteriaValues: () => [] }) }, /実際「選択肢を読めません」/],
  ];
  for (const [label, over, re] of variants) {
    const s = setup();
    wrapPlan(s.gas, 'A02', (c, orig) => {
      const ss = s.gas.context.SpreadsheetApp.getActiveSpreadsheet();
      const insert = ss.insertSheet;
      ss.insertSheet = (n, i) => { const sh = insert(n, i); if (n === '自己テスト_回答') sh.getRange = wrapRange(sh.getRange, over); return sh; };
      try { orig(c); } finally { ss.insertSheet = insert; }
    });
    s.run();
    const r = results(s.gas);
    assert.equal(r.A02.result, '×', label);
    assert.match(r.A02.detail, re, label);
    notAllPass(s, label);
  }
});

test('処理日時（tester）: 不正な日付（Invalid Date）・数（シリアル値）・空が返ると A02 が ×', () => {
  for (const [label, value] of [['Invalid Date', new Date(NaN)], ['数', 46313.4], ['空', '']]) {
    const s = setup({ onGetValues: (name, values, r) => (name === '自己テスト_回答' && r === 2 ? values.map((row) => row.map((v, j) => (row.length === 7 && j === 6 ? value : v))) : values) });
    s.run();
    const r = results(s.gas);
    assert.equal(r.A02.result, '×', label);
    assert.match(r.A02.detail, /G2 の処理日時が日付ではありません/, label);
  }
});

test('壊す（tester）: 管理列を見出しで探せず毎回足す・ログのシート名を変える・e.range でなく最後の行を処理する、のどれでも「すべて合格」にならない', () => {
  const a = setup();
  breakSource(a, 'ensureManagementColumns_', 'var idx = headers.indexOf(pair[0]);', 'var idx = -1;');
  a.run();
  assert.equal(results(a.gas).A03.result, '×');
  notAllPass(a, '管理列');

  const b = setup();
  b.ctx.SHEET_LOG = '処理ログ';
  b.run();
  assert.equal(results(b.gas).A02.result, '×');
  assert.match(results(b.gas).A02.detail, /足された行 0 行。期待 3 行/);
  notAllPass(b, 'ログのシート名');
  noMail(b);

  const c = setup();
  breakSource(c, 'handleFormSubmit_', 'var row = e.range.getRow();', 'var row = sheet.getLastRow();');
  c.run();
  assert.equal(results(c.gas).A04.result, '×');
  notAllPass(c, '最後の行');
  noMail(c);
});

// =====================================================================
// 監査（docs/reviews/selftest-inquiry-audit.md）の壊し方。送信の関数の差し替え（c）と残りの通数（a）。director 2026-10-19
// =====================================================================
const M = 'main.js';
const DR = 'var dryRun = config.DRY_RUN !== false;';
const GIVEN = 'var config = given || loadConfig_();';
const NE_COND = 'if (config.DRY_RUN === false && config.NOTIFY_TO) {';
const THROW_AFTER_SEND = 'sheet.getRange(row, cols.id).setValue(inquiryId);'; // 送信のあとに例外
const REAL_CONFIG = [['キー', '値', '説明'], ['DRY_RUN', 'FALSE', ''], ['EMAIL_FIELD', 'メールアドレス', ''], ['NAME_FIELD', 'お名前', ''],
  ['NOTIFY_TO', 'owner@example.com', ''], ['SENDER_NAME', 'x', ''], ['REPLY_SUBJECT', 's {{受付番号}}', ''], ['REPLY_BODY', 'b', ''], ['NOTIFY_SUBJECT', 'n {{受付番号}}', '']];
// [名前, 本番の書き換え, 最初からあるシート]。監査の表の 12 行と同じ順
const AUDIT_CASES = [
  ['正しい本番', []],
  ['var dryRun = false;', [[M, DR, 'var dryRun = false;']]],
  ["dryRun = config.DRY_RUN === 'TRUE'", [[M, DR, "var dryRun = config.DRY_RUN === 'TRUE';"]]],
  ['sendMail_ の return が抜ける', [[M, "' / ' + mail.subject);\n    return;\n  }", "' / ' + mail.subject);\n  }"]]],
  ['if (dryRun) の中でも MailApp.sendEmail を呼ぶ（ログは送信予定のまま）', [[M, 'if (dryRun) {\n    writeLog_(', 'if (dryRun) {\n    MailApp.sendEmail(mail);\n    writeLog_(']]],
  ['dryRun が壊れ、送信のログの文も違う', [[M, DR, 'var dryRun = false;'], [M, "'送信しました: '", "'送信済み: '"]]],
  ['dryRun が壊れ、送信のログを書かない', [[M, DR, 'var dryRun = false;'], [M, "  MailApp.sendEmail(mail);\n  writeLog_('INFO', inquiryId, '送信しました: ' + mail.to + ' / ' + mail.subject);", '  MailApp.sendEmail(mail);']]],
  ['handleFormSubmit_ が「設定」を読む・「設定」なし', [[M, GIVEN, 'var config = loadConfig_();']]],
  ['handleFormSubmit_ が「設定」を読む・「設定」が FALSE で実在しうる宛先', [[M, GIVEN, 'var config = loadConfig_();']], { '設定': REAL_CONFIG }],
  ['notifyError_ の DRY_RUN の判定が消える＋本番の中で例外', [[M, NE_COND, 'if (config.NOTIFY_TO) {'], [M, THROW_AFTER_SEND, "throw new Error('x'); " + THROW_AFTER_SEND]]],
  ['dryRun が壊れる＋送信のあとに例外＋notifyError_ の判定なし', [[M, DR, 'var dryRun = false;'], [M, NE_COND, 'if (config.NOTIFY_TO) {'], [M, THROW_AFTER_SEND, "throw new Error('x'); " + THROW_AFTER_SEND]]],
  ['2 回目の呼び出しから dryRun が壊れる', [[M, DR, 'var dryRun = config.DRY_RUN !== false; if (row > 2) dryRun = false;']]],
];
function runCase([, transforms, sheets], extra) {
  const s = setup(Object.assign({ transforms, sheets: sheets || {} }, extra || {}));
  s.run();
  return { s, r: results(s.gas) };
}
const MAIL_CALLED = /本番の処理がメールの送信（MailApp\.sendEmail）を \d+ 回呼びました（差し替えていたので送っていません）/;
const NOT_REPLACED = '送信の関数を差し替えられませんでした（送ったかは、1 日に送れる残りの通数とログで見ました）';

test('監査の壊し方（差し替えが効く）: 正しい本番だけが「すべて合格」。どの壊し方でも「すべて合格」にならず、実際の sendEmail は 0 回', () => {
  const overall = {};
  for (const c of AUDIT_CASES) {
    const { s, r } = runCase(c);
    overall[c[0]] = r['0'].result;
    assert.deepEqual(s.gas.calls.mails, [], c[0] + ': 実際に送った');
    assert.equal(s.gas.calls.drafts, 0, c[0]);
    assert.equal(s.ctx.MailApp, s.gas.calls.realMailApp, c[0] + ': 終わったら本物に戻す');
    for (const id of JUDGED) assert.doesNotMatch(r[id].detail, /差し替えられませんでした/, c[0] + ' ' + id);
  }
  assert.deepEqual(overall, {
    '正しい本番': 'すべて合格',
    'var dryRun = false;': '不合格',
    "dryRun = config.DRY_RUN === 'TRUE'": '不合格',
    'sendMail_ の return が抜ける': '不合格',
    'if (dryRun) の中でも MailApp.sendEmail を呼ぶ（ログは送信予定のまま）': '不合格',
    'dryRun が壊れ、送信のログの文も違う': '不合格',
    'dryRun が壊れ、送信のログを書かない': '不合格',
    'handleFormSubmit_ が「設定」を読む・「設定」なし': '不合格',
    'handleFormSubmit_ が「設定」を読む・「設定」が FALSE で実在しうる宛先': '未完了',
    'notifyError_ の DRY_RUN の判定が消える＋本番の中で例外': '不合格',
    'dryRun が壊れる＋送信のあとに例外＋notifyError_ の判定なし': '不合格',
    '2 回目の呼び出しから dryRun が壊れる': '不合格',
  });
});

test('監査の偽の「すべて合格」: if (dryRun) の中でも送る（ログは送信予定のまま）と、A02 が ×（送信の関数が 2 回呼ばれた）。A03〜A05 は流さない。実際には送らない', () => {
  const { s, r } = runCase(AUDIT_CASES[4]);
  assert.equal(r.A02.result, '×');
  assert.equal(r.A02.detail, '確かめた 11 / 11。本番の処理がメールの送信（MailApp.sendEmail）を 2 回呼びました（差し替えていたので送っていません）');
  for (const id of ['A03', 'A04', 'A05']) assert.equal(r[id].detail, SENT_DETAIL, id);
  assert.equal(r['0'].result, '不合格');
  assert.match(s.gas.calls.alerts[0], /M01・M02 を書いてから/);
  noMail(s);
});

test('壊し方ごとの、送信の関数が呼ばれた項目: 呼ばれた項目は ×、詳細に回数。エラーの通知（notifyError_）の送信も数える', () => {
  const calledIn = (r) => JUDGED.filter((id) => MAIL_CALLED.test(r[id].detail));
  for (const c of AUDIT_CASES) {
    const { r } = runCase(c);
    for (const id of calledIn(r)) assert.equal(r[id].result, '×', c[0] + ' ' + id);
  }
  assert.deepEqual(calledIn(runCase(AUDIT_CASES[0]).r), []);
  assert.deepEqual(calledIn(runCase(AUDIT_CASES[11]).r), ['A03']);
  // notifyError_ の判定が消える＋例外: 渡した設定（DRY_RUN = TRUE）でも NOTIFY_TO に通知を送ろうとする → 1 回
  const n = runCase(AUDIT_CASES[9]).r;
  assert.match(n.A02.detail, /を 1 回呼びました/);
  // dryRun が壊れる＋送信のあとに例外＋notifyError_ の判定なし → 自動返信・通知・エラーの通知で 3 回
  assert.match(runCase(AUDIT_CASES[10]).r.A02.detail, /を 3 回呼びました/);
});

test('差し替えが効かない（MailApp を書き換えられない）: 残りの通数が減ったら ×（(a)）。詳細に「差し替えられませんでした」。どの壊し方でも「すべて合格」にならず、送るのは 3 通まで（宛先は @example.com だけ）', () => {
  // 監査の偽の「すべて合格」の壊し方: ログは送信予定のままだが、残りの通数が 100 → 98 に減るので A02 が ×
  const { s, r } = runCase(AUDIT_CASES[4], { mailFixed: true });
  assert.notEqual(s.ctx.MailApp, undefined);
  assert.equal(r.A02.result, '×');
  assert.equal(r.A02.detail, '確かめた 11 / 11。本番の処理がメールを送りました（1 日に送れる残りの通数が 100 から 98 に減りました）。' + NOT_REPLACED);
  for (const id of ['A03', 'A04', 'A05']) assert.equal(r[id].detail, SENT_DETAIL, id);
  assert.equal(r['0'].result, '不合格');
  assert.deepEqual(s.gas.calls.mails.map((m) => m.to), ['yamada@example.com', 'notify@example.com']);

  // 正しい本番なら ○ のまま、詳細に差し替えられなかったことを足す
  const ok = runCase(AUDIT_CASES[0], { mailFixed: true });
  assert.equal(ok.r['0'].result, 'すべて合格');
  for (const id of ['A02', 'A03', 'A04', 'A05']) {
    assert.equal(ok.r[id].result, '○', id);
    assert.ok(ok.r[id].detail.endsWith('。' + NOT_REPLACED), id + ': ' + ok.r[id].detail);
  }
  noMail(ok.s);

  // 監査の表のどの壊し方でも
  for (const c of AUDIT_CASES.slice(1)) {
    const x = runCase(c, { mailFixed: true });
    assert.notEqual(x.r['0'].result, 'すべて合格', c[0]);
    assert.ok(x.s.gas.calls.mails.length <= 3, c[0] + ': ' + x.s.gas.calls.mails.length + ' 通');
    for (const m of x.s.gas.calls.mails) assert.match(m.to, /@example\.com$/, c[0]);
  }
});

test('差し替えが途中で元に戻る（呼んでいる間に MailApp が本物に戻る）: 差し替えが効かなかったとして (a) に頼る', () => {
  const s = setup({ transforms: [AUDIT_CASES[4][1][0]] });
  const orig = s.ctx.handleFormSubmit_;
  s.ctx.handleFormSubmit_ = (e, config) => { s.ctx.MailApp = s.gas.calls.realMailApp; return orig(e, config); };
  s.run();
  const r = results(s.gas);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, /残りの通数が 100 から 98 に減りました）。送信の関数を差し替えられませんでした/);
  assert.equal(r['0'].result, '不合格');
});

test('差し替えが効かず、残りの通数も読めない（director 2026-10-19）: ○ にせず未実施「送信を見張れないので判定しません」。残りの A02〜A05 も流さない。違いがあれば ×', () => {
  const UNWATCHED = '送信を見張れないので判定しません（送信の関数を差し替えられず、1 日に送れる残りの通数も読めませんでした）';
  assert.equal(st.SELFTEST_UNWATCHED, UNWATCHED);
  // 正しい本番でも ○ にしない。全体は「すべて合格」にならない
  const ok = setup({ mailFixed: true, quota: NaN });
  const seen = recordSubmits(ok);
  ok.run();
  let r = results(ok.gas);
  for (const id of ['A02', 'A03', 'A04', 'A05']) {
    assert.equal(r[id].result, '未実施', id);
    assert.equal(r[id].detail, UNWATCHED, id);
  }
  assert.equal(r.A01.result, '○');
  assert.equal(r.A06.result, '○');
  assert.equal(r['0'].result, '未完了');
  assert.deepEqual(seen.map((x) => x.row), [2], '見張れないまま本番を何度も呼ばない');
  noMail(ok);
  // 違いがあれば ×（未実施で × を隠さない）。詳細に理由も足す
  const bad = setup({ mailFixed: true, quota: NaN });
  bad.ctx.STATUS_NEW = '新規';
  bad.run();
  r = results(bad.gas);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, /期待「未対応」実際「新規」.*。送信を見張れないので判定しません/);
  assert.equal(r['0'].result, '不合格');
  // 監査の表のどの壊し方でも「すべて合格」にならない
  for (const c of AUDIT_CASES) assert.notEqual(runCase(c, { mailFixed: true, quota: NaN }).r['0'].result, 'すべて合格', c[0]);
  // 差し替えが効けば、通数が読めなくても何も足さない
  const g = runCase(AUDIT_CASES[0], { quota: NaN });
  assert.equal(g.r.A02.detail, '確かめた 11 / 11');
  assert.equal(g.r['0'].result, 'すべて合格');
});

test('差し替えは必ず元に戻す: 本番の処理が例外を外に投げても、MailApp は本物に戻る', () => {
  const s = setup();
  s.ctx.handleFormSubmit_ = () => { throw new Error('外に出る例外'); };
  s.run();
  const r = results(s.gas);
  assert.equal(r.A02.result, '×');
  assert.equal(r.A02.detail, '例外: 外に出る例外');
  assert.equal(s.ctx.MailApp, s.gas.calls.realMailApp);
});

test('全体の詳細（監査 推奨 1）: 「設定」があって流さなかったときは「「設定」シートを消してから、もう一度押してください」', () => {
  const s = setup({ sheets: { '設定': [['キー', '値', '説明']] } });
  s.run();
  const r = results(s.gas);
  assert.equal(r['0'].result, '未完了');
  assert.equal(r['0'].detail, '未実施 4 件。「設定」シートを消してから、もう一度押してください');
  assert.equal(st.overallResult(['A01', 'A02'], { A01: { result: '○' }, A02: { result: '未実施', detail: st.SELFTEST_CONFIG_EXISTS } }).detail, '未実施 1 件。「設定」シートを消してから、もう一度押してください');
});

test('最後の画面（監査 推奨 2）: 途中で日付が変わり × を残したときは「M01・M02 はまだ書かずに、もう一度押してください」', () => {
  assert.equal(st.selfTestFinalMessage_({ result: '不合格', detail: 'x' }, true), '自己テストの結果: 不合格。x\nM01・M02 はまだ書かずに、もう一度押してください。');
  let n = 0;
  const s = setup({ dayKey: () => (n++ === 0 ? todayKey() : '29991231') });
  s.ctx.STATUS_NEW = '新規';
  s.run();
  assert.equal(results(s.gas)['0'].result, '不合格');
  assert.match(s.gas.calls.alerts[0], /\nM01・M02 はまだ書かずに、もう一度押してください。$/);
  // 日付が変わらなければ今までどおり
  const t = setup();
  t.ctx.STATUS_NEW = '新規';
  t.run();
  assert.match(t.gas.calls.alerts[0], /\nM01・M02 を書いてから「自己テスト」シートを送ってください。$/);
});

test('M01 の (4)（監査 必須 1 (b)）: Gmail の「送信済み」に example.com 宛てが増えていないか、を見る', () => {
  const m01 = st.SELFTEST_MANUAL.find((m) => m.id === 'M01').title;
  assert.match(m01, /\(4\) Gmail の「送信済み」に example\.com 宛てが増えていないか \(5\)/);
  assert.doesNotMatch(m01, /メールが届いていないか/);
});

// =====================================================================
// 再監査（docs/reviews/selftest-inquiry-audit.md「再監査」）
// =====================================================================
// dryRun が壊れる＋送信のあとに例外＋catch の中の writeLog_ が例外を投げる（例外が handleFormSubmit_ の外まで出る）
const ESCAPE_CASE = ['dryRun が壊れる＋送信のあとの例外が外まで出る', [[M, DR, 'var dryRun = false;'], [M, THROW_AFTER_SEND, "throw new Error('x'); " + THROW_AFTER_SEND],
  [M, "writeLog_('ERROR', inquiryId, String(err && err.stack || err));", 'throw err;']]];

test('再監査 必須 1: 例外が handleFormSubmit_ の外まで出ても、見張りの結果を捨てない。差し替えが効く・効かず通数がある・効かず通数もない、のどれでも 2 通（差し替えが効けば 0 通）で止まり、A03〜A05 は未実施', () => {
  const conditions = [
    ['差し替えが効く', {}, 0],
    ['差し替えが効かず、通数がある', { mailFixed: true }, 2],
    ['差し替えが効かず、通数もない', { mailFixed: true, quota: NaN }, 2],
  ];
  for (const [label, extra, sent] of conditions) {
    const { s, r } = runCase(ESCAPE_CASE, extra);
    assert.equal(r.A02.result, '×', label);
    assert.match(r.A02.detail, /^例外: x/, label);
    for (const id of ['A03', 'A04', 'A05']) assert.equal(r[id].result, '未実施', label + ' ' + id);
    assert.equal(r['0'].result, '不合格', label);
    assert.equal(s.gas.calls.mails.length, sent, label);
    for (const m of s.gas.calls.mails) assert.match(m.to, /@example\.com$/, label);
    assert.equal(s.ctx.MailApp, s.gas.calls.realMailApp, label + ': 本物に戻す');
    if (label === '差し替えが効く') assert.match(r.A02.detail, /送信（MailApp\.sendEmail）を 2 回呼びました/);
    if (label === '差し替えが効かず、通数がある') assert.match(r.A02.detail, /100 から 98 に減りました/);
    if (label === '差し替えが効かず、通数もない') assert.match(r.A02.detail, /送信を見張れないので判定しません/);
  }
});

test('再監査 必須 2: I05 に送信の関数を差し替えたか。差し替えた（4 回とも）／差し替えられない／呼んでいない', () => {
  assert.equal(st.selfTestMailGuardText_(0, 0), '送信の関数=呼んでいない');
  assert.equal(st.selfTestMailGuardText_(4, 4), '送信の関数=差し替えた（4 回とも）');
  assert.equal(st.selfTestMailGuardText_(4, 3), '送信の関数=差し替えられない（4 回のうち、差し替えられたのは 3 回）');
  const i05 = (s) => cellOf(s.gas, 'I05', 5);
  const ok = runCase(AUDIT_CASES[0]);
  assert.equal(i05(ok.s), '送信の関数=差し替えた（4 回とも）');
  // 監査で「差し替えられませんでした」の文が出なかった 4 通り: どれも I05 は「差し替えた」にならない
  const fixed = [
    ['通数が読めない', { mailFixed: true, quota: NaN }],
    ['「設定」あり', { mailFixed: true, sheets: { '設定': [['キー', '値']] } }],
    ['初期値の DRY_RUN が FALSE', { mailFixed: true, transforms: [[M, "['DRY_RUN', 'TRUE',", "['DRY_RUN', 'FALSE',"]] }],
    ['本番の例外が外へ出る', { mailFixed: true, transforms: [[M, "writeLog_('ERROR', inquiryId, String(err && err.stack || err));", 'throw err;'], [M, 'var sheet = e.range.getSheet();', "throw new Error('y'); var sheet = e.range.getSheet();"]] }],
  ];
  for (const [label, opts] of fixed) {
    const s = setup(opts);
    s.run();
    assert.doesNotMatch(i05(s), /差し替えた/, label + ': ' + i05(s));
    assert.notEqual(results(s.gas)['0'].result, 'すべて合格', label);
  }
});

test('再監査 推奨 2: 見張れないときの全体の詳細の例は、最初の押し直しても実施できない項目の詳細から取る', () => {
  const { r } = runCase(AUDIT_CASES[0], { mailFixed: true, quota: NaN });
  assert.equal(r['0'].result, '未完了');
  assert.equal(r['0'].detail, '未実施 4 件のうち 4 件は、押し直しても実施できません（例: A02 は「送信を見張れないので判定しません（送信の関数を差し替えられず、1 日に送れる残りの通数も読めませんでした）」）。この画面を送ってください');
});

test('再監査 任意 1（静的）: main.js が MailApp を使うのは sendMail_ と notifyError_ の中だけ（関数の外で控えると、差し替えを素通りするため）', () => {
  const source = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const code = source.split('\n').map((l) => (/^\s*(\*|\/\/|\/\*\*)/.test(l) ? '' : l)).join('\n');
  const where = [];
  let i = -1;
  while ((i = code.indexOf('MailApp', i + 1)) !== -1) {
    const head = code.slice(0, i);
    const fnStart = head.lastIndexOf('\nfunction ');
    const fnName = fnStart === -1 ? null : head.slice(fnStart + 10).match(/^[A-Za-z0-9_$]+/)[0];
    const closed = fnStart === -1 || head.slice(fnStart).includes('\n}\n');
    where.push(closed ? '（関数の外）' : fnName);
  }
  assert.ok(where.length > 0);
  assert.deepEqual([...new Set(where)].sort(), ['notifyError_', 'sendMail_']);
});

test('再監査: 本番が MailApp を関数の外で控えると差し替えを素通りするが、残りの通数で × になり、2 通で止まる', () => {
  const c = ['最上位で控える', [[M, DR, 'var dryRun = false;'], [M, "  MailApp.sendEmail(mail);\n  writeLog_('INFO', inquiryId, '送信しました: '", "  M_.sendEmail(mail);\n  writeLog_('INFO', inquiryId, '送信しました: '"],
    [M, "var SHEET_CONFIG = '設定';", "var SHEET_CONFIG = '設定'; var M_ = MailApp;"]]];
  const { s, r } = runCase(c);
  assert.equal(r.A02.result, '×');
  assert.match(r.A02.detail, /100 から 98 に減りました/);
  for (const id of ['A03', 'A04', 'A05']) assert.equal(r[id].detail, SENT_DETAIL, id);
  assert.equal(s.gas.calls.mails.length, 2);
});
