/**
 * 自己テスト（src/selftest.js）自体のテスト。仕様 docs/specs/selftest.md 9.2。
 * main.test.js の makeSheet を広げたモックをこのファイルの中に作り、その上で ○ も × も未実施も正しく出ること、
 * 本番のコードや Google の返り値をわざと壊しても偽の ○ にならないことを確かめる。
 * Google の上での動き（PDF の URL の形、getParents、toString など）は、モックでは分からない（README の自己テストで確かめる）。
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

// =====================================================================
// モック
// =====================================================================
/**
 * options:
 *   name: スプレッドシートの名前、sheets: { 名前: 行 }（最初からあるシート）、docLock: getDocumentLock が取れるか、
 *   onGetValues(sheetName, values): getValues の戻り値を書き換える（Google の返り値のまね）、
 *   urlOf(id): ファイルの getUrl の形、pdfSize: PDF の大きさ、withSelfTest: selftest.js を読むか（既定 true）
 */
function createGas(options = {}) {
  const o = Object.assign({ name: '自己テスト_請求書', sheets: {}, docLock: true, pdfSize: 2048, withSelfTest: true }, options);
  const calls = { alerts: [], drafts: 0, draftTo: [], mails: 0, driveCreateFile: 0, folderCreateFile: 0, createFolder: [], flush: 0, menu: [], activated: [] };
  let sheetSeq = 0;
  const sheets = [];

  function makeSheet(name, rows = []) {
    const data = rows.map((r) => r.slice());
    const formats = {};
    const backgrounds = {};
    const fontColors = {};
    const sheet = {
      name,
      id: ++sheetSeq,
      data,
      formats,
      backgrounds,
      fontColors,
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
    };
    return self;
  }

  Object.entries(o.sheets).forEach(([n, rows]) => sheets.push(makeSheet(n, rows)));
  const ss = {
    getName: () => o.name,
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

  // ドライブ: フォルダとファイル
  const drive = { folders: { ROOT: { id: 'ROOT', name: 'マイドライブ', trashed: false } }, files: {} };
  let fileSeq = 0;
  let folderSeq = 0;
  const iterator = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
  const folderApi = (F) => ({
    getId: () => F.id,
    getName: () => F.name,
    getUrl: () => 'https://drive.google.com/drive/folders/' + F.id,
    isTrashed: () => F.trashed,
    createFile: (blob) => { calls.folderCreateFile++; return makeFile(blob, F.id); },
  });
  const fileApi = (f) => ({
    getId: () => f.id,
    getName: () => f.name,
    getMimeType: () => f.mime,
    getSize: () => f.size,
    getUrl: () => (o.urlOf ? o.urlOf(f.id) : 'https://drive.google.com/file/d/' + f.id + '/view?usp=drivesdk'),
    getParents: () => iterator(f.parents.map((p) => folderApi(drive.folders[p]))),
  });
  function makeFile(blob, parent) {
    const id = 'FileId' + String(++fileSeq).padStart(6, '0') + 'xyzXYZ';
    drive.files[id] = { id, name: blob.name, mime: blob.mime, size: o.pdfSize, parents: [parent] };
    return fileApi(drive.files[id]);
  }
  const DriveApp = {
    createFile: (blob) => { calls.driveCreateFile++; return makeFile(blob, 'ROOT'); },
    getFileById: (id) => { if (!drive.files[id]) throw new Error('ファイルがありません（モック）'); return fileApi(drive.files[id]); },
    getFolderById: (id) => { if (!drive.folders[id]) throw new Error('フォルダがありません（モック）'); return folderApi(drive.folders[id]); },
    getFoldersByName: (n) => iterator(Object.values(drive.folders).filter((F) => F.name === n).map(folderApi)),
    createFolder: (n) => {
      calls.createFolder.push(n);
      const id = 'FolderId' + String(++folderSeq).padStart(6, '0') + 'abcABC';
      drive.folders[id] = { id, name: n, trashed: false };
      return folderApi(drive.folders[id]);
    },
  };

  const menuBuilder = {
    addItem: (label, fn) => { calls.menu.push([label, fn]); return menuBuilder; },
    addSeparator: () => { calls.menu.push(['---']); return menuBuilder; },
    addToUi: () => {},
  };
  const pad = (n) => String(n).padStart(2, '0');
  const context = vm.createContext({
    console: { log() {}, error() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => ({ alert: (m) => { calls.alerts.push(m); }, createMenu: () => menuBuilder }),
      flush: () => { calls.flush++; },
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
      getDocumentLock: () => ({ tryLock: () => o.docLock, releaseLock: () => {} }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      // 日本時間（+9 時間）で yyyy-MM-dd HH:mm と yyyy-MM だけ
      formatDate: (d, tz, fmt) => {
        const j = new Date(d.getTime() + 9 * 3600 * 1000);
        const ymd = j.getUTCFullYear() + '-' + pad(j.getUTCMonth() + 1);
        if (fmt === 'yyyy-MM') return ymd;
        return ymd + '-' + pad(j.getUTCDate()) + ' ' + pad(j.getUTCHours()) + ':' + pad(j.getUTCMinutes());
      },
      newBlob: (html) => ({
        getAs: (mime) => { const b = { name: '', mime, html }; b.setName = (n) => { b.name = n; return b; }; return b; },
      }),
    },
    DriveApp,
    GmailApp: { createDraft: (to) => { calls.drafts++; calls.draftTo.push(to); return {}; } },
    MailApp: { sendEmail: () => { calls.mails++; } },
  });
  for (const f of o.withSelfTest ? FILES : ['main.js', 'lib.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
  }
  return {
    context,
    calls,
    drive,
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
/** runInvoicesWith_ の呼び出しを記録する（請求月と設定の DRY_RUN） */
function recordInvoices(s) {
  const seen = [];
  const orig = s.ctx.runInvoicesWith_;
  s.ctx.runInvoicesWith_ = (ym, date, config) => {
    seen.push({ ym, date: date.getTime(), dryRun: config && config.DRY_RUN, folderId: config && config.FOLDER_ID, config });
    return orig(ym, date, config);
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

// =====================================================================
// 全体
// =====================================================================
test('正しいデータ: 全体が「すべて合格」、判定の項目がすべて ○ で、確かめた数が分母と同じ。Gmail とメールは 0 回', () => {
  const s = setup();
  const seen = recordInvoices(s);
  const out = s.run();
  assert.equal(out.status, 'done');
  const r = results(s.gas);
  assert.equal(r['0'].result, 'すべて合格', r['0'].detail);
  assert.equal(r['0'].detail, '判定 6 件がすべて ○（自動の項目だけ）。本番のメニューでの確認（M01）と承認画面の文（M02）は、手で書いてから送ってください');
  assert.deepEqual(JUDGED, ['B01', 'B02', 'B03', 'B04', 'B05', 'B06']);
  const counts = { B01: 1, B02: 8, B03: 6, B04: 5, B05: 17, B06: 1 };
  for (const id of JUDGED) {
    assert.equal(r[id].result, '○', id + ': ' + r[id].detail);
    assert.ok(r[id].detail.startsWith('確かめた ' + counts[id] + ' / ' + counts[id]), id + ': ' + r[id].detail);
    assert.equal(r[id].run, '1');
  }
  assert.match(r.B06.detail, /「設定」なし。ないままかだけを確認/);
  // B02・B04 は DRY_RUN、B05 だけ FALSE で 2 回。請求月は正規化した形、発行日は 2026-10-31
  assert.deepEqual(seen.map((x) => [x.ym, x.dryRun]), [['202610', true], ['202610', true], ['202610', false], ['202610', false]]);
  assert.ok(seen.every((x) => x.date === new Date(2026, 9, 31).getTime()));
  assert.equal(new Set(seen.map((x) => x.config)).size, 3, '設定のオブジェクトを項目どうしで共有しない（B05 の 2 回は同じ）');
  assert.equal(s.ctx.DEFAULT_CONFIG[0][1], 'TRUE');
  // 外部への影響: 下書き・メールは 0 回。確認用 PDF は B02 で 2、B04 で 1。本番の PDF は B05 の 1 回目で 2
  assert.equal(s.gas.calls.drafts, 0);
  assert.equal(s.gas.calls.mails, 0);
  assert.equal(s.gas.calls.driveCreateFile, 3);
  assert.equal(s.gas.calls.folderCreateFile, 2);
  assert.deepEqual(s.gas.calls.createFolder, ['自己テスト_請求書']);
  assert.equal(s.gas.calls.alerts.length, 1);
  assert.match(s.gas.calls.alerts[0], /^自己テストの結果: すべて合格。[\s\S]*M01・M02 を書いてから「自己テスト」シートを送ってください。$/);
  assert.deepEqual(s.gas.calls.activated, ['自己テスト']);
  assert.deepEqual(new Set(s.gas.sheetNames()), new Set(['自己テスト', '顧客', '請求明細', '発行履歴', 'ログ']));
  assert.equal(s.gas.sheetNames().length, 5);
  assert.equal(s.gas.sheetNames()[0], '自己テスト');
});

test('2 回目に押しても「すべて合格」。フォルダ「自己テスト_請求書」は作り直さず、ログは消さずに行を足す', () => {
  const s = setup();
  s.run();
  const logRows = s.gas.sheet('ログ').getLastRow();
  s.run();
  assert.equal(results(s.gas)['0'].result, 'すべて合格');
  assert.deepEqual(s.gas.calls.createFolder, ['自己テスト_請求書']);
  assert.ok(s.gas.sheet('ログ').getLastRow() > logRows);
  // ゴミ箱に入ったフォルダは使わない
  Object.values(s.gas.drive.folders).forEach((F) => { if (F.name === '自己テスト_請求書') F.trashed = true; });
  s.run();
  assert.equal(results(s.gas)['0'].result, 'すべて合格');
  assert.deepEqual(s.gas.calls.createFolder, ['自己テスト_請求書', '自己テスト_請求書']);
});

test('結果のシート: 17 行。見出しは灰色・太字・固定、書いた範囲はすべて @、M01・M02 の E 列だけ黄色（M03 は白）、× の D 列だけ赤', () => {
  const s = setup();
  s.ctx.SELFTEST_INVOICES[1].total = 7767; // わざと違う期待値で × を 1 つ出す
  s.run();
  const sheet = s.gas.sheet('自己テスト');
  const rows = sheet.text();
  assert.equal(rows.length, 17);
  assert.deepEqual(rows.map((r) => r[0]), ['番号', '0', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', '', 'M01', 'M02', 'M03', '', 'I01', 'I02', 'I03', 'I04']);
  assert.deepEqual(rows[0], st.SELFTEST_HEADERS);
  for (let r = 1; r <= 17; r++) for (let c = 1; c <= 7; c++) assert.equal(sheet.formats[r + ',' + c], '@', r + ',' + c);
  for (let c = 1; c <= 7; c++) {
    assert.equal(sheet.backgrounds['1,' + c], '#e0e0e0');
    assert.equal(sheet.bold['1,' + c], 'bold');
  }
  assert.equal(sheet.frozen, 1);
  assert.equal(sheet.backgrounds['10,5'], '#fff8c5');
  assert.equal(sheet.backgrounds['11,5'], '#fff8c5');
  assert.equal(sheet.backgrounds['12,5'], '#ffffff');
  assert.equal(sheet.backgrounds['7,5'], '#ffffff');
  assert.deepEqual(sheet.widths, { 3: 320, 5: 480 });
  assert.equal(rows[6][3], '×');
  assert.equal(sheet.fontColors['7,4'], '#c62828');
  assert.equal(sheet.fontColors['6,4'], '#000000');
  assert.equal(rows[11][4], st.SELFTEST_M03_TEXT);
  assert.equal(cellOf(s.gas, 'I01', 5), '1=2026-10-18 10:02');
  assert.equal(cellOf(s.gas, 'I02', 5), 'SELFTEST_VERSION=2026-10-19 / スプレッドシート=自己テスト_請求書');
  assert.match(cellOf(s.gas, 'I03', 5), /^コード=[0-9a-f]{8}$/);
  assert.equal(cellOf(s.gas, 'I04', 5), 'なし');
  // 個人の情報と ID: example.com 以外のメールアドレス・drive.google.com・ファイルとフォルダの ID がない。= で始まる値がない
  const all = rows.flat().join('\n');
  assert.doesNotMatch(all, /drive\.google\.com|docs\.google\.com/);
  assert.doesNotMatch(all, /FileId|FolderId/);
  for (const m of all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) assert.match(m, /@example\.com$/);
  assert.ok(rows.flat().every((v) => !v.startsWith('=')));
});

test('名前の確認: 名前が「自己テスト」で始まらないと、何も書かずに文を出して終わる', () => {
  const s = setup({ name: '請求書_本番', sheets: { '顧客': [['依頼者のデータ']] } });
  const before = s.gas.sheet('顧客').text();
  assert.equal(s.run().status, 'notTestSpreadsheet');
  assert.deepEqual(s.gas.sheetNames(), ['顧客']);
  assert.deepEqual(s.gas.sheet('顧客').text(), before);
  assert.deepEqual(s.gas.calls.alerts, [s.ctx.SELFTEST_NAME_MESSAGE]);
  assert.equal(s.gas.calls.driveCreateFile, 0);
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
  setCell(s.gas, 'M01', 5, '(1) ① 初期設定・サンプルデータを入れる・② 請求書を作成する');
  const before = s.gas.sheet('自己テスト').text();
  const names = s.gas.sheetNames();
  const files = s.gas.calls.driveCreateFile;
  assert.equal(s.run().status, 'manualWritten');
  assert.deepEqual(s.gas.sheet('自己テスト').text(), before);
  assert.deepEqual(s.gas.sheetNames(), names);
  assert.equal(s.gas.calls.driveCreateFile, files);
  assert.equal(s.gas.calls.alerts[s.gas.calls.alerts.length - 1], s.ctx.SELFTEST_MANUAL_STOP_MESSAGE);
  setCell(s.gas, 'M01', 5, '');
  setCell(s.gas, 'M02', 5, ' 　');
  assert.equal(s.run().status, 'done');
  assert.equal(cellOf(s.gas, 'M02', 5), '');
  assert.equal(results(s.gas)['0'].result, 'すべて合格');
});

test('「設定」（推奨 8）: 「設定」があれば読まず、書かず、全セルを比べて ○。途中で 1 セル変わると B06 が ×（値は詳細に書かない）', () => {
  const rows = [['キー', '値', '説明'], ['DRY_RUN', 'FALSE', ''], ['FOLDER_ID', 'OwnersFolderId0001', '']];
  const s = setup({ sheets: { '設定': rows } });
  s.run();
  let r = results(s.gas);
  assert.equal(r['0'].result, 'すべて合格');
  assert.equal(r.B06.detail, '確かめた 9 / 9');
  assert.deepEqual(s.gas.sheet('設定').text(), rows);

  const t = setup({ sheets: { '設定': rows } });
  wrapPlan(t.gas, 'B04', (c, orig) => { orig(c); t.gas.sheet('設定').getRange(3, 2).setValue('ChangedFolderId01'); });
  t.run();
  r = results(t.gas);
  assert.equal(r.B06.result, '×');
  assert.match(r.B06.detail, /^確かめた 9 \/ 9。設定 B3 が変わりました$/);
  assert.doesNotMatch(sheetRows(t.gas).flat().join('\n'), /FolderId/);
  assert.equal(r['0'].result, '不合格');

  const u = setup();
  wrapPlan(u.gas, 'B05', (c, orig) => { orig(c); u.gas.context.SpreadsheetApp.getActiveSpreadsheet().insertSheet('設定'); });
  u.run();
  assert.equal(results(u.gas).B06.result, '×');
  assert.match(results(u.gas).B06.detail, /「設定」がなかったのに/);
});

// =====================================================================
// わざと違う結果・本番のコードを壊す（偽の ○ にならない）
// =====================================================================
test('わざと違う結果: sampleData の単価を変えると B02 が ×、詳細に ¥49,500 と実際の金額。全体は「不合格」', () => {
  const s = setup();
  const orig = s.ctx.sampleData;
  s.ctx.sampleData = (ym) => { const d = orig(ym); d.items[0][4] = 33000; return d; };
  s.run();
  const r = results(s.gas);
  assert.equal(r.B02.result, '×');
  assert.match(r.B02.detail, /文に「確認用 PDF: 株式会社サンプル商事 ¥49,500」の行がありません（実際: 確認用 PDF: 株式会社サンプル商事 ¥52,800）/);
  assert.equal(r.B05.result, '×');
  assert.match(r.B05.detail, /請求金額: 期待「49500」実際「52800」/);
  assert.equal(r['0'].result, '不合格');
  assert.match(r['0'].detail, /^× が \d 件（番号: .*B02/);
});

test('本番の関数を期待値に使わない（4.5）: calcInvoice の消費税を切り上げにすると、¥7,766 の B02・B04・B05 が ×', () => {
  const s = setup();
  const orig = s.ctx.calcInvoice;
  s.ctx.calcInvoice = (items) => orig(items, 'ceil');
  s.run();
  const r = results(s.gas);
  for (const id of ['B02', 'B04', 'B05']) assert.equal(r[id].result, '×', id);
  assert.match(r.B02.detail, /実際: 確認用 PDF: テスト合同会社 ¥7,767/);
  assert.match(r.B05.detail, /期待「7766」実際「7767」/);
  notAllPass(s);
});

test('壊す: formatYen が区切りを付けない、nextInvoiceNumber がいつも 001 を返すと「すべて合格」にならない', () => {
  const a = setup();
  a.ctx.formatYen = (n) => '¥' + n;
  a.run();
  assert.equal(results(a.gas).B02.result, '×');
  assert.equal(results(a.gas).B04.result, '×');

  const b = setup();
  b.ctx.nextInvoiceNumber = (nums, ym) => 'INV-' + ym + '-001';
  b.run();
  const r = results(b.gas);
  assert.equal(r.B03.result, '×');
  assert.match(r.B03.detail, /名前: 期待「\[確認用\]INV-202610-002_テスト合同会社\.pdf」実際「\[確認用\]INV-202610-001_テスト合同会社\.pdf」/);
  assert.equal(r.B05.result, '×');
  notAllPass(b);
});

test('壊す: 本番が DRY_RUN を無視して発行履歴を書くと B02 が ×（発行履歴が見出しだけでない・文の頭）', () => {
  const s = setup();
  const orig = s.ctx.runInvoicesWith_;
  s.ctx.runInvoicesWith_ = (ym, d, config) => orig(ym, d, Object.assign({}, config, { DRY_RUN: false, FOLDER_ID: 'ROOT' }));
  s.run();
  const r = results(s.gas);
  assert.equal(r.B02.result, '×');
  assert.match(r.B02.detail, /文が「【お試しモード】」で始まりません/);
  assert.match(r.B02.detail, /ほか 2 か所$/); // 発行履歴とログの行（3 か所より後ろ）
});

test('請求月の形（推奨 4）: runInvoicesWith_ に \'202610\' で渡す。\'2026-10\' で渡すと B02 が ×', () => {
  const s = setup();
  s.ctx.SELFTEST_YEAR_MONTH = '2026-10';
  s.run();
  const r = results(s.gas);
  assert.equal(r.B02.result, '×');
  assert.match(r.B02.detail, /created が 0（期待 2）: 2026-10 の請求明細がありません|created が 0（期待 2）/);
  notAllPass(s);
});

test('項目どうしの状態（推奨 4）: B04 の発行履歴が残ったままでも、B05 の 1 回目が created 2（B05 の始めに作り直す）', () => {
  const s = setup();
  const seen = [];
  wrapPlan(s.gas, 'B05', (c, orig) => { seen.push(s.gas.sheet('発行履歴').getLastRow()); orig(c); });
  s.run();
  assert.equal(seen[0], 2, 'B04 の発行履歴が B05 の前に残っている');
  assert.equal(results(s.gas).B05.result, '○', results(s.gas).B05.detail);
  // 作り直しを壊す（「発行履歴」を消せない）と B05 が ×
  const t = setup();
  const ss = t.gas.context.SpreadsheetApp.getActiveSpreadsheet();
  const del = ss.deleteSheet;
  wrapPlan(t.gas, 'B05', (c, orig) => { ss.deleteSheet = (sh) => { if (sh.getName() !== '発行履歴') del(sh); }; try { orig(c); } finally { ss.deleteSheet = del; } });
  t.run();
  assert.equal(results(t.gas).B05.result, '×');
});

test('DRY_RUN が FALSE の初期値: B01 が ×、B02〜B05 は流さずに未実施。下書き・メール・PDF は 0 回', () => {
  const s = setup();
  s.ctx.DEFAULT_CONFIG[0][1] = 'FALSE';
  const seen = recordInvoices(s);
  s.run();
  const r = results(s.gas);
  assert.equal(r.B01.result, '×');
  assert.match(r.B01.detail, /初期値の DRY_RUN が「false」（期待 TRUE）/);
  for (const id of ['B02', 'B03', 'B04', 'B05']) {
    assert.equal(r[id].result, '未実施', id);
    assert.equal(r[id].detail, '実施できません: DRY_RUN が TRUE でないので止めました');
  }
  assert.equal(r.B06.result, '○');
  assert.equal(r['0'].result, '不合格');
  assert.deepEqual(seen, []);
  assert.equal(s.gas.calls.drafts, 0);
  assert.equal(s.gas.calls.mails, 0);
  assert.equal(s.gas.calls.driveCreateFile, 0);
  assert.equal(s.gas.calls.folderCreateFile, 0);
  assert.deepEqual(s.gas.calls.createFolder, []);
});

test('B05 の守り: 「顧客」の読み直しで 1 人に有効なアドレスが残る（書いたあとに値が戻るまね）と、B05 は流さずに ×。createDraft は 0 回', () => {
  const s = setup({
    onGetValues: (name, values, r) => {
      if (name !== '顧客' || r !== 1 || values.length < 2) return values;
      return values.map((row, i) => (i === 1 ? row.map((v, j) => (j === 4 && v === '' ? 'yamada@example.com' : v)) : row));
    },
  });
  const seen = recordInvoices(s);
  s.run();
  const r = results(s.gas);
  assert.equal(r.B05.result, '×');
  assert.match(r.B05.detail, /メールアドレスになりうる値が残っています: E2（下書きを作らないように、流していません）/);
  assert.ok(seen.every((x) => x.dryRun === true), 'B05 の runInvoicesWith_ は呼ばない');
  assert.equal(s.gas.calls.drafts, 0);
  assert.equal(s.gas.calls.folderCreateFile, 0);
  assert.equal(r['0'].result, '不合格');
});

test('B05 の全セル（任意 7）: メールアドレス以外の列（会社名）に有効なアドレスが残っても、流さずに ×。DEFAULT_CONFIG の DRY_RUN は TRUE のまま', () => {
  const s = setup();
  const orig = s.ctx.sampleData;
  s.ctx.sampleData = (ym) => { const d = orig(ym); d.customers[1][1] = 'sato@example.com'; return d; };
  const seen = recordInvoices(s);
  s.run();
  const r = results(s.gas);
  assert.equal(r.B05.result, '×');
  assert.match(r.B05.detail, /B3/);
  assert.ok(seen.every((x) => x.dryRun === true));
  assert.equal(s.gas.calls.drafts, 0);
  assert.equal(s.ctx.parseConfigRows(s.ctx.DEFAULT_CONFIG).DRY_RUN, true);
});

test('B05 の守り（4.5 の例外）: 本番の isValidEmail が空の文字を有効とみなすように壊れていると、B05 は流さずに ×（createDraft まで進まない）', () => {
  const s = setup();
  const orig = s.ctx.isValidEmail;
  s.ctx.isValidEmail = (v) => v === '' || orig(v);
  s.run();
  const r = results(s.gas);
  assert.equal(r.B05.result, '×');
  assert.match(r.B05.detail, /E2・E3/);
  assert.equal(s.gas.calls.drafts, 0);
});

test('B05 の守りの自己テスト側の決まり（@ を含む）は、本番の isValidEmail より広い: @ を含まない値はどれも isValidEmail が偽', () => {
  const values = ['', ' ', 'C001', '株式会社サンプル商事', '御中', '山田 太郎', 'not-an-email', 'example.com', 'a.b.c', '0', 'TRUE', '\'2026-10'];
  for (const v of values) {
    assert.equal(lib.isValidEmail(v), false, v);
    assert.deepEqual(st.selfTestEmailCells_([['見出し'], [v]], lib.isValidEmail), [], v);
  }
  for (const v of ['a@example.com', ' b@example.com ', 'x@y', '@']) assert.deepEqual(st.selfTestEmailCells_([['h'], [v]], lib.isValidEmail), ['A2'], v);
  // sampleData の顧客でメールアドレスを空にした行は、どのセルも引っかからない
  const rows = [['h1', 'h2', 'h3', 'h4', 'h5']].concat(lib.sampleData('2026-10').customers.map((r) => r.slice(0, 4).concat([''])));
  assert.deepEqual(st.selfTestEmailCells_(rows, lib.isValidEmail), []);
  assert.deepEqual(st.selfTestEmailCells_([['h'], [null, undefined, 0]], () => false), []);
});

test('PDF の URL を読めない: ログの URL の形を変えると B03 が ×。詳細に URL の形（ID とホストは伏せる）', () => {
  const s = setup({ urlOf: (id) => 'https://drive.google.com/open?id=' + id });
  s.run();
  const r = results(s.gas);
  assert.equal(r.B03.result, '×');
  assert.match(r.B03.detail, /^確かめた 6 \/ 6。\[確認用\]INV-202610-001_株式会社サンプル商事\.pdf: ログの URL から ID を取れません（URL の形: \/open\?id=\{ID\}）/);
  assert.doesNotMatch(r.B03.detail, /FileId/);
  assert.equal(r.B05.result, '×');
  assert.equal(r['0'].result, '不合格');
});

test('確認用 PDF が空（大きさ 0）だと B03 が ×', () => {
  const s = setup({ pdfSize: 0 });
  s.run();
  assert.equal(results(s.gas).B03.result, '×');
  assert.match(results(s.gas).B03.detail, /大きさが 0/);
});

test('確かめた数: log_ が 1 回目だけ書かないと B02 が ×（ログの行の数）、B03 も ×（2 つ目の PDF の行がない）', () => {
  const s = setup();
  const orig = s.ctx.log_;
  let n = 0;
  s.ctx.log_ = (level, message) => { n++; if (n === 1) return; orig(level, message); };
  s.run();
  const r = results(s.gas);
  assert.equal(r.B02.result, '×');
  assert.match(r.B02.detail, /ログに足された行が 1 行で、うち INFO の「\[DRY_RUN\] 確認用 PDF を作成: 」が 1 行（期待 2 行と 2 行）/);
  assert.equal(r.B03.result, '×');
  assert.match(r.B03.detail, /ログに確認用 PDF の行がありません/);
});

test('確かめた数が足りなければ未実施、多ければ ×（項目の関数が check を飛ばす・増やす）', () => {
  const s = setup();
  wrapPlan(s.gas, 'B01', (c) => { c.expect(2); c.check('1 つ目', true); });
  wrapPlan(s.gas, 'B06', (c) => { c.expect(1); c.check('1', true); c.check('2', true); });
  s.run();
  const r = results(s.gas);
  assert.equal(r.B01.result, '未実施');
  assert.equal(r.B01.detail, '実施できません: 確かめた 1 / 2');
  for (const id of ['B02', 'B03', 'B04', 'B05']) assert.equal(r[id].detail, '実施できません: DRY_RUN が TRUE でないので止めました', id);
  assert.equal(r.B06.result, '×');
  assert.equal(r.B06.detail, '自己テストのコードの誤り: 確かめた 2 / 1');
  assert.equal(r['0'].result, '不合格');
});

test('最後の画面（7 章・版 5）: 「未完了」（B01 が未実施で残りも未実施）なら「M01・M02 はまだ書かないでください。」。「M01・M02 を書いてから」は出さない', () => {
  const s = setup();
  wrapPlan(s.gas, 'B01', (c) => { c.expect(2); c.check('1 つ目', true); });
  s.run();
  assert.equal(results(s.gas)['0'].result, '未完了');
  assert.equal(s.gas.calls.alerts.length, 1);
  assert.match(s.gas.calls.alerts[0], /^自己テストの結果: 未完了。[\s\S]*\nM01・M02 はまだ書かないでください。$/);
  assert.doesNotMatch(s.gas.calls.alerts[0], /M01・M02 を書いてから/);
});

test('違いのあとの notRun（5 章・版 4）: 違いを 1 つ見つけたあとで実施できなくなっても ×。詳細に違いと理由の両方', () => {
  const s = setup();
  wrapPlan(s.gas, 'B04', (c) => { c.expect(5); c.check('created', false, 'created が 0（期待 1）'); c.notRun('実施できません: わざと'); });
  wrapPlan(s.gas, 'B06', (c) => { c.expect(5); c.check('ok', true); c.notRun('実施できません: わざと'); });
  s.run();
  const r = results(s.gas);
  assert.equal(r.B04.result, '×');
  assert.equal(r.B04.detail, '確かめた 1 / 5。created が 0（期待 1）。実施できません: わざと');
  assert.equal(r.B06.result, '未実施');
  assert.equal(r.B06.detail, '実施できません: わざと');
});

test('項目の中で例外: その項目が × で、次の項目は流れる。B02 の中の例外は B03 も ×', () => {
  const s = setup();
  wrapPlan(s.gas, 'B04', () => { throw new Error('わざとの例外'); });
  s.run();
  let r = results(s.gas);
  assert.equal(r.B04.result, '×');
  assert.equal(r.B04.detail, '例外: わざとの例外');
  assert.equal(r.B05.result, '○');
  assert.equal(r['0'].result, '不合格');

  const t = setup();
  wrapPlan(t.gas, 'B02', () => { throw new Error('B02 の例外'); });
  t.run();
  r = results(t.gas);
  assert.equal(r.B02.result, '×');
  assert.equal(r.B03.result, '×');
  assert.equal(r.B03.detail, '例外（B02 の中）: B02 の例外');

  // B02 が B03 を作らずに終わる（自己テストのコードの誤り）と、B03 は ○ にならない
  const u = setup();
  wrapPlan(u.gas, 'B02', (c) => { c.expect(1); c.check('x', true); });
  u.run();
  assert.equal(results(u.gas).B03.result, '未実施');
  assert.equal(results(u.gas).B03.detail, '実施できません: B02 の途中で止まったため');
});

test('「自己テスト」シートへの書き込み自体が失敗すると、alert に出して終わる（○ はどこにも出ない）', () => {
  const s = setup();
  s.ctx.selfTestWrite_ = () => { throw new Error('書けません'); };
  const out = s.run();
  assert.equal(out.status, 'error');
  assert.match(s.gas.calls.alerts[0], /自己テストが止まりました.*書けません/);
  assert.ok(!(sheetRows(s.gas) || []).flat().includes('○'));
});

test('静的: selftest.js に GmailApp・MailApp・.setTrashed( がない。外部に送る・消すメソッドもない', () => {
  const source = fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf8');
  for (const w of ['GmailApp', 'MailApp', 'UrlFetchApp', '.setTrashed(', '.moveTo(', '.makeCopy(', '.removeFile(', 'createDraft', 'sendEmail']) {
    assert.ok(!source.includes(w), 'selftest.js に ' + w);
  }
  // 期待値に本番の関数を使わない（4.5）。isValidEmail は B05 の守りだけ（表の例外）
  for (const w of ['calcInvoice', 'formatYen', 'nextInvoiceNumber', 'formatDateJa', 'calcDueDate', 'safeFileName', 'groupByCustomer', 'renderInvoiceHtml', 'HEADERS', 'SHEET', 'REQUIRED_KEYS']) {
    assert.ok(!new RegExp('(^|[^A-Za-z0-9_$])' + w + '[.([]').test(source), 'selftest.js に ' + w);
  }
  const code = source.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l) && !/^\s*'[A-Za-z0-9_$]+',$/.test(l));
  assert.deepEqual(code.filter((l) => l.includes('isValidEmail')).map((l) => l.trim()), ['var emails = selfTestEmailCells_(customers, isValidEmail);'], 'isValidEmail は B05 の守りの 1 か所だけ');
});

// =====================================================================
// tester が足した壊し方（2026-10-19。docs/reviews/selftest-invoice-test.md）
// =====================================================================
/** 本番の runInvoicesWith_ の本文の一部を書き換えて読み直す（本番のコードを壊すまね） */
function breakMain(s, from, to) {
  const source = s.ctx.runInvoicesWith_.toString();
  assert.ok(source.includes(from), '本番のコードに「' + from + '」がありません（テストを直してください）');
  vm.runInContext(source.replace(from, to), s.ctx);
}
const CONFIG_SHEET = [['キー', '値', '説明'], ['DRY_RUN', 'TRUE', ''], ['FOLDER_ID', '', '']];

test('壊す（下書き）: 本番の DRY_RUN の判定が壊れて B02・B04 が本番モードで流れても、下書きは 0 回（どの項目も宛先を空にする）', () => {
  // 「設定」があると、本番の getFolder_ が FOLDER_ID を書き戻して先へ進み、宛先があれば createDraft まで行く
  const s = setup({ sheets: { '設定': CONFIG_SHEET } });
  breakMain(s, 'config.DRY_RUN !== false', "config.DRY_RUN === 'TRUE'");
  s.run();
  const r = results(s.gas);
  assert.equal(r.B02.result, '×');
  assert.match(r.B02.detail, /文が「【お試しモード】」で始まりません/);
  assert.equal(r.B04.result, '×');
  assert.equal(r.B06.result, '×', '本番が「設定」に FOLDER_ID を書き戻したことが B06 で見える');
  assert.equal(r['0'].result, '不合格');
  assert.equal(s.gas.calls.drafts, 0, '下書きの宛先: ' + JSON.stringify(s.gas.calls.draftTo));
  assert.equal(s.gas.calls.mails, 0);
  // 「顧客」は最後まで宛先が空のまま
  assert.deepEqual(s.gas.sheet('顧客').text().slice(1).map((row) => row[4]), ['', '']);
});

test('壊す（下書き）: 本番が渡した設定を無視して「設定」シート（DRY_RUN = FALSE）を読んでも、下書きは 0 回で「すべて合格」にならない', () => {
  const s = setup({ sheets: { '設定': [['キー', '値', '説明'], ...defaultConfigRows({ DRY_RUN: 'FALSE' })] } });
  breakMain(s, 'var config = given || loadConfig_(ss);', 'var config = loadConfig_(ss);');
  s.run();
  notAllPass(s);
  assert.equal(results(s.gas).B02.result, '×');
  assert.equal(s.gas.calls.drafts, 0, JSON.stringify(s.gas.calls.draftTo));
});
/** main.js の DEFAULT_CONFIG と同じ行（over のキーだけ値を差し替える） */
function defaultConfigRows(over) {
  const ctx = createGas({ withSelfTest: false }).context;
  return ctx.DEFAULT_CONFIG.map((row) => [row[0], Object.prototype.hasOwnProperty.call(over, row[0]) ? over[row[0]] : row[1], row[2]]);
}

test('B05 の守りの限界: 本番が isValidEmail を見ずに下書きを作るように壊れると、B05 は ×。下書きは宛先が空のものだけ', () => {
  const s = setup();
  breakMain(s, 'if (isValidEmail(email)) {', 'if (true) {');
  s.run();
  const r = results(s.gas);
  assert.equal(r.B05.result, '×');
  assert.match(r.B05.detail, /Gmail下書き: 期待「未作成」実際「作成済み」/);
  assert.equal(r['0'].result, '不合格');
  // 自己テストからは止められない（本番の判定に頼る守りのため）。宛先はすべて空で、example.com を含め誰にも届く形ではない
  assert.ok(s.gas.calls.draftTo.every((to) => to === ''), JSON.stringify(s.gas.calls.draftTo));
});

test('B05: 「自己テスト_請求書」フォルダの ID を取れないと、流さずに ×（本番に「請求書」フォルダを作らせず、「設定」に書き戻させない）', () => {
  const s = setup({ sheets: { '設定': CONFIG_SHEET } });
  const orig = s.ctx.selfTestFolder_;
  s.ctx.selfTestFolder_ = () => Object.assign({}, orig(), { getId: () => '' });
  const seen = recordInvoices(s);
  s.run();
  const r = results(s.gas);
  assert.equal(r.B05.result, '×');
  assert.match(r.B05.detail, /^確かめた 17 \/ 17。「自己テスト_請求書」フォルダの ID を取れないので、流していません$/);
  assert.ok(seen.every((x) => x.dryRun === true), 'B05 の runInvoicesWith_ は呼ばない');
  assert.ok(!s.gas.calls.createFolder.includes('請求書'));
  assert.deepEqual(s.gas.sheet('設定').text(), CONFIG_SHEET);
  assert.equal(r.B06.result, '○');
});

test('壊す: 本番が FOLDER_ID を無視してマイドライブに保存すると B05 が ×（親のフォルダ）', () => {
  const s = setup();
  breakMain(s, 'var folder = dryRun ? null : getFolder_(ss, config);', "var folder = dryRun ? null : DriveApp.getFolderById('ROOT');");
  s.run();
  const r = results(s.gas);
  assert.equal(r.B05.result, '×');
  assert.match(r.B05.detail, /発行履歴の 2 行目: 親のフォルダが「自己テスト_請求書」ではありません/);
  notAllPass(s);
});

test('壊す: 発行履歴の確認をなくすと B04・B05 が ×。月だけで見る（ほかの顧客までスキップ）と B04 が ×', () => {
  const a = setup();
  breakMain(a, "if (issued[yearMonth + '|' + group.customerId]) {", 'if (false) {');
  a.run();
  let r = results(a.gas);
  assert.equal(r.B04.result, '×');
  assert.equal(r.B05.result, '×');
  assert.match(r.B05.detail, /2 回目: created が 2（期待 0）/);

  const b = setup();
  breakMain(b, "if (issued[yearMonth + '|' + group.customerId]) {", "if (issued[yearMonth + '|C001']) {");
  b.run();
  r = results(b.gas);
  assert.equal(r.B04.result, '×');
  assert.match(r.B04.detail, /created が 0（期待 1）/);
  notAllPass(b);
});

test('壊す: 確認用 PDF が PDF でない（HTML のまま）と B03 が ×。ログの URL がどれも同じファイルを指すと B03・B05 が ×', () => {
  const a = setup();
  breakMain(a, 'var preview = DriveApp.createFile(pdf);', "var preview = DriveApp.createFile(Object.assign({}, pdf, { mime: 'text/html' }));");
  a.run();
  assert.equal(results(a.gas).B03.result, '×');
  assert.match(results(a.gas).B03.detail, /MIME が「text\/html」/);
  notAllPass(a);

  const b = setup({ urlOf: () => 'https://drive.google.com/file/d/FileId000001xyzXYZ/view' });
  b.run();
  const r = results(b.gas);
  assert.equal(r.B03.result, '×');
  assert.match(r.B03.detail, /名前: 期待「\[確認用\]INV-202610-002_テスト合同会社\.pdf」実際「\[確認用\]INV-202610-001_株式会社サンプル商事\.pdf」/);
  assert.equal(r.B05.result, '×');
});

test('B03 を B02 の中で確かめる: PDF の中身を読むところで例外になっても、B03 だけが ×（B02 の結果を例外で消さない）', () => {
  const s = setup();
  const get = s.ctx.DriveApp.getFileById;
  s.ctx.DriveApp.getFileById = (id) => Object.assign({}, get(id), { getMimeType: () => { throw new Error('読めません'); } });
  s.run();
  const r = results(s.gas);
  assert.equal(r.B02.result, '○', r.B02.detail);
  assert.equal(r.B03.result, '×');
  assert.match(r.B03.detail, /^確かめた 6 \/ 6。\[確認用\]INV-202610-001_株式会社サンプル商事\.pdf: ファイルを読めません: 読めません/);
  assert.equal(r['0'].result, '不合格');
});

test('「ログ」に前の行と空の行があっても、足された行だけを数える（モックの getLastRow は Sheets と同じく、最後の中身のある行まで）', () => {
  const log = [['日時', 'レベル', '内容'], ['x', 'INFO', '[DRY_RUN] 確認用 PDF を作成: https://drive.google.com/file/d/OldFile0001/view'], [], ['y', 'ERROR', '前の失敗'], ['', '', ''], []];
  const s = setup({ sheets: { 'ログ': log } });
  // モックの決まり: 途中の空の行は数え、最後の空の行は数えない（Sheets の getLastRow は「中身のある最後の行」）
  assert.equal(s.gas.sheet('ログ').getLastRow(), 4);
  s.run();
  const r = results(s.gas);
  assert.equal(r['0'].result, 'すべて合格', r['0'].detail);
  // 前の行は消さず、足した行は 5 行目から（最後の空の行に詰める）
  const rows = s.gas.sheet('ログ').text();
  assert.deepEqual(rows.slice(0, 4).map((x) => x[2]), ['内容', log[1][2], '', '前の失敗']);
  assert.match(rows[4][2], /^\[DRY_RUN\] 確認用 PDF を作成: /);
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
  assert.equal(st.overallResult(['B01'], { B01: ok }).result, 'すべて合格');
  assert.equal(st.overallResult([], {}).result, '不合格');
  assert.match(st.overallResult(['B01', 'B02'], { B01: ok }).detail, /結果のない番号があります: B02/);
  assert.match(st.overallResult(['B01'], { B01: ok, B09: ok }).detail, /予定にない番号の結果があります: B09/);
  assert.match(st.overallResult(['B01'], { B01: { result: '記録' } }).detail, /結果の値が違います/);
  assert.deepEqual(plain(st.overallResult(['B01', 'B02'], { B01: { result: '×' }, B02: { result: '実行中' } })), { result: '不合格', detail: '× が 1 件（番号: B01）。未実施 1 件は、もう一度押すと最初から実施します' });
  assert.equal(st.overallResult(['B01'], { B01: { result: '未実施', detail: '時間: まだ実施していません' } }).detail, '未実施 1 件。もう一度「自己テスト（開発用）」を押すと最初から実施します');
  assert.match(st.overallResult(['B01'], { B01: { result: '未実施', detail: '実施できません: x' } }).detail, /押し直しても実施できません/);
});

test('selfTestFinalMessage_（版 5）: M01・M02 を書いて送るのは「すべて合格」と「不合格」のときだけ。「未完了」では「まだ書かない」。個人の情報は伏せる', () => {
  const send = '\nM01・M02 を書いてから「自己テスト」シートを送ってください。';
  assert.equal(st.selfTestFinalMessage_({ result: 'すべて合格', detail: 'a' }), '自己テストの結果: すべて合格。a' + send);
  assert.equal(st.selfTestFinalMessage_({ result: '不合格', detail: 'b' }), '自己テストの結果: 不合格。b' + send);
  assert.equal(st.selfTestFinalMessage_({ result: '未完了', detail: 'c' }), '自己テストの結果: 未完了。c\nM01・M02 はまだ書かないでください。');
  assert.doesNotMatch(st.selfTestFinalMessage_({ result: '不合格', detail: 'a@example.org' }), /a@example\.org/);
});

test('buildSelfTestValues: 7 列の文字。M03 の E 列は決まった文、M01・M02 は渡した値。example.com 以外のメールアドレスと URL は伏せる', () => {
  const rows = st.buildSelfTestValues(
    [{ id: '0', kind: '全体', title: '全体の判定', result: '○', detail: 'a@example.org と b@example.com と https://drive.google.com/x', seconds: 1.25, run: 1 }],
    [{ id: 'M01', title: 'm1', detail: '書いた' }, { id: 'M02', title: 'm2', detail: '' }, { id: 'M03', title: 'm3', detail: 'x' }],
    st.selfTestInfoRows_('2026-10-18 10:02', 'v', '自己テスト_請求書', 'abcd1234'),
  );
  assert.ok(rows.every((r) => r.length === 7 && r.every((v) => typeof v === 'string')));
  assert.equal(rows[1][4], '（メールアドレスは伏せました） と b@example.com と （URL は伏せました）');
  assert.equal(rows[1][5], '1.3');
  assert.equal(rows[3][4], '書いた');
  assert.equal(rows[5][4], st.SELFTEST_M03_TEXT);
  assert.deepEqual(rows.slice(7).map((r) => [r[0], r[4]]), [['I01', '1=2026-10-18 10:02'], ['I02', 'SELFTEST_VERSION=v / スプレッドシート=自己テスト_請求書'], ['I03', 'コード=abcd1234'], ['I04', 'なし']]);
});

test('selfTestPdfId_ と selfTestUrlShape_: /d/{ID} から ID を取る。形はホストと ID を伏せる', () => {
  assert.equal(st.selfTestPdfId_('https://drive.google.com/file/d/AbC_123-xyz/view?usp=drivesdk'), 'AbC_123-xyz');
  assert.equal(st.selfTestPdfId_('https://drive.google.com/open?id=AbC'), '');
  assert.equal(st.selfTestPdfId_(undefined), '');
  assert.equal(st.selfTestUrlShape_('https://drive.google.com/file/d/AbCdEfGhIjKl123/view'), '/file/d/{ID}/view');
  assert.equal(st.selfTestUrlShape_(''), '（空）');
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
  vm.runInContext(c.calcInvoice.toString().replace('subtotal + tax', 'subtotal + tax + 0'), c);
  assert.notEqual(printOf(), print);
  print = printOf();
  c.SELFTEST_INVOICES[1].total = 7767;
  assert.notEqual(printOf(), print);
  print = printOf();
  c.SELFTEST_PLAN.find((p) => p.id === 'B04').run = c.selfTestB02_;
  assert.notEqual(printOf(), print);

  const native = (n) => { const v = c[n]; if (typeof v !== 'function') return v; const f = function () {}; f.toString = () => 'function () { [native code] }'; return f; };
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, native).ok, false);
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, (n) => (n === 'runInvoicesWith_' ? undefined : c[n])).ok, false);
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, (n) => (n === 'DEFAULT_CONFIG' ? undefined : c[n])).ok, false);
  assert.equal(st.fingerprintSources(['a'], [], () => { throw new Error('x'); }).ok, false);
});

test('fingerprintSources（8.3 の 4）: 1 つの関数を引けないと I03 が「コード=取れません」（判定は変えない）', () => {
  const s = setup();
  s.ctx.renderTemplate = 1;
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
  assert.ok(st.SELFTEST_FINGERPRINT_FUNCS.includes('runInvoicesWith_') && st.SELFTEST_FINGERPRINT_FUNCS.includes('calcInvoice') && st.SELFTEST_FINGERPRINT_FUNCS.includes('selfTestB05_'));
  assert.ok(st.SELFTEST_FINGERPRINT_VARS.includes('DEFAULT_CONFIG') && st.SELFTEST_FINGERPRINT_VARS.includes('SELFTEST_PLAN') && st.SELFTEST_FINGERPRINT_VARS.includes('SELFTEST_INVOICES'));
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

test('SELFTEST_PLAN: B01〜B06 の順。B03 は B02 の中で確かめ、B02〜B05 は B01 が前提。期待値は数字で書いてある（C001 = 49,500、C002 = 7,766）', () => {
  assert.deepEqual(st.SELFTEST_PLAN.map((x) => x.id), ['B01', 'B02', 'B03', 'B04', 'B05', 'B06']);
  assert.ok(st.SELFTEST_PLAN.every((x) => x.kind === '判定'));
  const p = Object.fromEntries(st.SELFTEST_PLAN.map((x) => [x.id, x]));
  assert.equal(p.B03.by, 'B02');
  assert.equal(p.B03.run, null);
  for (const id of ['B02', 'B03', 'B04', 'B05']) assert.equal(p[id].needs, 'B01');
  assert.equal(p.B06.needs, undefined);
  assert.deepEqual(st.SELFTEST_INVOICES.map((x) => [x.customerId, x.number, x.total]), [['C001', 'INV-202610-001', 49500], ['C002', 'INV-202610-002', 7766]]);
  // 期待値を自己テストに数字で書いたあと、正しい本番の計算と一致するか（本番を変えたら、ここで両方を見直す）
  const d = lib.sampleData('2026-10');
  const items = (id) => d.items.filter((r) => r[1] === id).map((r) => ({ name: r[2], quantity: r[3], unitPrice: r[4], taxRate: r[5] }));
  assert.equal(lib.calcInvoice(items('C001'), 'floor').total, 49500);
  assert.equal(lib.calcInvoice(items('C002'), 'floor').total, 7766);
  assert.equal(lib.formatYen(49500), '¥49,500');
  assert.equal(lib.formatYen(7766), '¥7,766');
  assert.equal(lib.nextInvoiceNumber(['INV-202610-001'], '202610'), 'INV-202610-002');
  assert.equal(lib.normalizeYearMonth('2026-10'), '202610');
});

test('メニュー: selftest.js を読んだときだけ「自己テスト（開発用）」が足される', () => {
  const s = setup();
  s.ctx.onOpen();
  assert.deepEqual(s.gas.calls.menu.map((x) => x[0]), ['① 初期設定（シート作成）', 'サンプルデータを入れる', '---', '② 請求書を作成する', '---', '自己テスト（開発用）']);
  assert.equal(s.gas.calls.menu[5][1], 'runSelfTest');
  const p = createGas({ withSelfTest: false });
  p.context.onOpen();
  assert.deepEqual(p.calls.menu.map((x) => x[0]), ['① 初期設定（シート作成）', 'サンプルデータを入れる', '---', '② 請求書を作成する']);
});
