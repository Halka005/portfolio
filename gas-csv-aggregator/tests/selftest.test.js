/**
 * 自己テスト（src/selftest.js）自体のテスト。仕様 docs/specs/selftest.md 9.1。
 * モック（tests/gas-mock.js）の上で、○ も × も未実施も正しく出ること、偽の ○ にならないことを確かめる。
 * Google の上での動き（getValues が ' をどう返すか、toString、getSheetId など）は、モックでは分からない（README の自己テストで確かめる）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const st = require('../src/selftest.js');
const { createGas, casesTree, treeFolder, CASES_DIR } = require('./gas-mock.js');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['main.js', 'lib.js', 'gas-lib.js', 'selftest.js'];
const T0 = Date.UTC(2026, 9, 18, 1, 2); // 2026-10-18 10:02（日本時間）
const MIN = 60 * 1000;
const JUDGED = st.SELFTEST_PLAN.filter((p) => p.kind === '判定').map((p) => p.id);

// ---- 準備 ----
function syncCaseFiles(gas, tree) {
  const out = {};
  tree.folders.forEach((c) => {
    const files = {};
    ['input', 'expected'].forEach((sub) => {
      const f = (c.folders || []).find((x) => x.name === sub);
      (f ? f.files : []).forEach((x) => { files[sub + '/' + x.name] = x.bytes.length; });
    });
    (c.files || []).forEach((x) => { files[x.name] = x.bytes.length; });
    out[c.name] = files;
  });
  const target = gas.context.CASE_FILES;
  Object.keys(target).forEach((k) => delete target[k]);
  Object.assign(target, out);
}

/** mutate: ドライブの木を書き換える、sync: CASE_FILES を書き換えた木に合わせる（4.4 の確認を通して、項目の中の扱いを見るため） */
function setup({ mutate, sync, options = {}, name = '自己テスト_CSV集計' } = {}) {
  const tree = casesTree(mutate);
  const opts = Object.assign({ settingsRows: null, name, driveTree: [tree], withSelfTest: true }, options);
  const gas = createGas(opts);
  if (sync) syncCaseFiles(gas, tree);
  const clock = { t: T0 };
  return { gas, tree, opts, clock, ctx: gas.context, run: () => gas.selfTest(() => clock.t) };
}

function fileIn(tree, p) {
  const parts = p.split('/');
  const name = parts.pop();
  const folder = treeFolder(tree, parts.join('/'));
  return { folder, file: folder.files.find((f) => f.name === name) };
}
const editText = (tree, p, fn) => { const { file } = fileIn(tree, p); file.bytes = Buffer.from(fn(file.bytes.toString('utf8')), 'utf8'); };
const removeFile = (tree, p) => { const { folder, file } = fileIn(tree, p); folder.files.splice(folder.files.indexOf(file), 1); };
const removeLine = (tree, p, pred) => editText(tree, p, (t) => t.split(/(?<=\n)/).filter((l) => !pred(l)).join(''));

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
/** 項目 id のあとで時間を進める（その次の項目の前で 4 分を超えさせる）。戻り値の off() で止める */
function advanceAfter(s, id, ms = 5 * MIN) {
  const control = { on: true, off() { control.on = false; } };
  wrapPlan(s.gas, id, (c, orig) => { try { return orig(c); } finally { if (control.on) s.clock.t += ms; } });
  return control;
}
/** 「自己テスト」シートのセルを書き換える（オーナーの書き込みや、強制的に止められた状態のまね） */
function setCell(gas, id, col, value) {
  const sheet = gas.sheet('自己テスト');
  const rowIndex = sheet.text().findIndex((r) => r[0] === id);
  sheet.getRange(rowIndex + 1, col).setValues([[value]]);
}
const cellOf = (gas, id, col) => sheetRows(gas).find((r) => r[0] === id)[col - 1];

// =====================================================================
// 全体
// =====================================================================
test('正しいデータ: 全体が「すべて合格」、判定の項目がすべて ○ で、確かめた数が分母と同じ。項目の数は SELFTEST_PLAN と同じ', () => {
  const s = setup();
  const out = s.run();
  assert.equal(out.status, 'done');
  const r = results(s.gas);
  assert.equal(r['0'].result, 'すべて合格', r['0'].detail);
  assert.match(r['0'].detail, new RegExp('^判定 ' + JUDGED.length + ' 件がすべて ○（自動の項目だけ）。本番のメニューでの確認（M01）と承認画面の文（M02）は、手で書いてから送ってください$'));
  assert.equal(JUDGED.length, 19);
  for (const id of JUDGED) {
    assert.equal(r[id].result, '○', id + ': ' + r[id].detail);
    const m = /^確かめた (\d+) \/ (\d+)/.exec(r[id].detail);
    assert.ok(m && m[1] === m[2] && Number(m[1]) > 0, id + ': ' + r[id].detail);
    assert.equal(r[id].run, '1');
  }
  assert.equal(r.C06.result, '記録');
  assert.match(r.C06.detail, /^実行のあとの表示「#REF!」/);
  assert.equal(r.C21.result, '記録');
  assert.equal(Object.keys(r).filter((id) => /^C\d\d$/.test(id)).length, st.SELFTEST_PLAN.length);
  // 片付け: 作業用・作成中のシート、C10 の空の「明細」が残らない
  assert.deepEqual(s.gas.sheetNames(), ['集計', '月別合計', '明細', '取り込み結果', '自己テスト']);
  assert.ok(s.gas.sheet('明細').getLastRow() > 0);
  assert.equal(s.gas.calls.alerts.length, 1);
  assert.match(s.gas.calls.alerts[0], /^自己テストの結果: すべて合格。[\s\S]*M01・M02 を書いてから「自己テスト」シートを送ってください。$/);
  assert.deepEqual(s.gas.calls.forbidden, []);
  assert.equal(s.ctx.SJIS_CHARSET, 'windows-31j');
});

test('結果のシート: 32 行。見出しは灰色・太字・固定、書いた範囲はすべて @、M01・M02 の E 列だけ黄色（M03 は白）、列幅', () => {
  const s = setup();
  s.run();
  const sheet = s.gas.sheet('自己テスト');
  const rows = sheet.text();
  assert.equal(rows.length, 32);
  assert.deepEqual(rows[0], st.SELFTEST_HEADERS);
  assert.deepEqual(rows.map((r) => r[0]), ['番号', '0'].concat(st.SELFTEST_PLAN.map((p) => p.id), [''], ['M01', 'M02', 'M03'], [''], ['I01', 'I02', 'I03', 'I04']));
  for (let r = 1; r <= 32; r++) for (let c = 1; c <= 7; c++) assert.equal(sheet.format[r + ',' + c], '@', r + ',' + c);
  assert.equal(sheet.background['1,1'], '#e0e0e0');
  assert.equal(sheet.weight['1,1'], 'bold');
  assert.equal(sheet.frozen, 1);
  const rowOf = (id) => rows.findIndex((r) => r[0] === id) + 1;
  assert.equal(sheet.background[rowOf('M01') + ',5'], '#fff8c5');
  assert.equal(sheet.background[rowOf('M02') + ',5'], '#fff8c5');
  assert.equal(sheet.background[rowOf('M03') + ',5'], '#ffffff');
  assert.equal(sheet.background[rowOf('C01') + ',5'], '#ffffff');
  assert.equal(cellOf(s.gas, 'M03', 5), st.SELFTEST_M03_TEXT);
  assert.equal(cellOf(s.gas, 'M01', 5), '');
  assert.match(cellOf(s.gas, 'M01', 3), /「明細」の最後の行の番号（14 行目なら一致）/);
  assert.equal(sheet.widths[3], 320);
  assert.equal(sheet.widths[5], 480);
  assert.equal(sheet.wrap['2,5'], true);
  // 数式にならない・個人の情報を出さない（推奨 6）
  const all = rows.flat();
  assert.ok(!all.some((v) => v.startsWith('=')));
  assert.match(cellOf(s.gas, 'C20', 5), /-x→3/);
  assert.match(cellOf(s.gas, 'C21', 5), /「\+81」は数式なし/);
  assert.ok(!all.some((v) => /drive\.google\.com|docs\.google\.com/.test(v)));
  assert.ok(!all.some((v) => /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(v)));
  assert.ok(!all.some((v) => v.includes('CasesFolder0001') || /TreeFolder\d{4}/.test(v)), 'フォルダの ID を書かない');
  assert.match(cellOf(s.gas, 'I01', 5), /^1=2026-10-18 10:02$/);
  assert.equal(cellOf(s.gas, 'I02', 5), 'SELFTEST_VERSION=2026-10-19 / スプレッドシート=自己テスト_CSV集計');
  assert.match(cellOf(s.gas, 'I03', 5), /^SJIS_CHARSET=windows-31j \/ FORMULA_GUARD=true \/ ケースのフォルダ=[0-9a-f]{8} \/ コード=[0-9a-f]{8}$/);
  assert.equal(cellOf(s.gas, 'I04', 5), 'G1=0 / G2=0 / なし');
});

test('「設定」: 「設定」シートがあっても読まず、書かず、前後で中身が同じ。出力は「設定」の後ろに並ぶ', () => {
  const rowsBefore = [['CSV_FOLDER', 'https://drive.google.com/drive/folders/Nothing00001', ''], ['DEDUPE', 'abc', '']];
  const s = setup({ options: { settingsRows: rowsBefore } });
  const before = s.gas.sheet('設定').text();
  s.run();
  assert.equal(results(s.gas)['0'].result, 'すべて合格');
  assert.deepEqual(s.gas.sheet('設定').text(), before);
  assert.deepEqual(s.gas.sheetNames(), ['自己テスト', '設定', '集計', '月別合計', '明細', '取り込み結果']);
});

test('名前の確認: 名前が「自己テスト」で始まらないと、何も書かずに文を出して終わる', () => {
  const s = setup({ name: '売上の集計', options: { sheets: { 'メモ': [['依頼者のシート']] } } });
  const before = s.gas.sheetNames();
  const out = s.run();
  assert.equal(out.status, 'notTestSpreadsheet');
  assert.deepEqual(s.gas.sheetNames(), before);
  assert.deepEqual(s.gas.calls.alerts, [s.ctx.SELFTEST_NAME_MESSAGE]);
  assert.equal(s.gas.calls.scriptLocks, 0);
});

test('ロック: 自己テストが実行中（getDocumentLock が取れない）なら、何も書かずに終わる', () => {
  const s = setup({ options: { docLock: false } });
  assert.equal(s.run().status, 'locked');
  assert.deepEqual(s.gas.sheetNames(), []);
  assert.match(s.gas.calls.alerts[0], /自己テストが実行中です/);
});

test('「自己テスト」シートが自己テストのものでなければ、何も書かずに止まる', () => {
  const s = setup({ options: { sheets: { '自己テスト': [['依頼者', 'のシート']] } } });
  assert.equal(s.run().status, 'foreignSheet');
  assert.deepEqual(s.gas.sheetNames(), ['自己テスト']);
  assert.deepEqual(s.gas.sheet('自己テスト').text(), [['依頼者', 'のシート']]);
  assert.match(s.gas.calls.alerts[0], /「自己テスト」シートの名前を変えてから実行してください/);
});

test('ケースのフォルダ: 0 個・2 個なら「自己テスト設定」を作って止まり（「自己テスト」は作らない）、URL を貼れば動く。ゴミ箱のものは数えない', () => {
  // 0 個（名前が違う）
  const none = setup({ mutate: (t) => { t.name = 'cases-old'; } });
  assert.equal(none.run().status, 'noCases');
  assert.deepEqual(none.gas.sheetNames(), ['自己テスト設定']);
  assert.match(none.gas.calls.alerts[0], /見つかりませんでした。「自己テスト設定」シートの黄色のセルに/);
  const settings = none.gas.sheet('自己テスト設定');
  assert.deepEqual(settings.text().map((r) => r.slice(0, 2)), [['キー', '値'], ['CASES_FOLDER', '']]);
  assert.equal(settings.background['2,2'], '#fff8c5');
  assert.equal(settings.format['2,2'], '@');
  settings.getRange(2, 2).setValues([[' https://drive.google.com/drive/folders/CasesFolder0001?usp=sharing ']]);
  assert.equal(none.run().status, 'done');
  assert.equal(results(none.gas)['0'].result, 'すべて合格');

  // 2 個
  const twoTrees = [casesTree(), casesTree((t) => { t.id = 'CasesFolder0002'; })];
  const two = createGas({ settingsRows: null, name: '自己テスト_CSV集計', driveTree: twoTrees, withSelfTest: true });
  assert.equal(two.selfTest(() => T0).status, 'noCases');
  assert.match(two.calls.alerts[0], /2 つあります/);
  // 片方がゴミ箱なら 1 個
  const trashed = createGas({ settingsRows: null, name: '自己テスト_CSV集計', driveTree: [casesTree(), casesTree((t) => { t.id = 'CasesFolder0002'; t.trashed = true; })], withSelfTest: true });
  assert.equal(trashed.selfTest(() => T0).status, 'done');
  // getFoldersByName が使えない場合も、自己テスト設定に落ちる
  const thrown = setup({ options: { getFoldersByNameThrows: true } });
  assert.equal(thrown.run().status, 'noCases');
  assert.match(thrown.gas.calls.alerts[0], /探せませんでした/);
  // 貼った URL のフォルダに 01-basic がなければ止まる
  const wrong = setup({ options: { sheets: { '自己テスト設定': [['キー', '値', '説明'], ['CASES_FOLDER', 'https://drive.google.com/drive/folders/' + 'X'.repeat(12)]] } } });
  assert.equal(wrong.run().status, 'noCases');
  assert.match(wrong.gas.calls.alerts[0], /開けません/);
});

// =====================================================================
// 偽の ○ にならない（必須 1）
// =====================================================================
test('わざと違う期待値: 01 の details.csv の 1 セルを変えると C01 が × で、詳細に「明細 D4」と期待・実際がある。全体は「不合格」で D 列は赤', () => {
  // ① → ② はバイト数が同じなので、ファイルの確認（4.4）は通る
  const s = setup({ mutate: (t) => editText(t, '01-basic/expected/details.csv', (x) => x.replace('ギフトセット ①', 'ギフトセット ②')) });
  s.run();
  const r = results(s.gas);
  assert.equal(r.C01.result, '×');
  assert.match(r.C01.detail, /明細 D4: 期待「ギフトセット ②」実際「ギフトセット ①」/);
  assert.equal(r['0'].result, '不合格');
  assert.match(r['0'].detail, /^× が \d+ 件（番号: C01/);
  assert.equal(r.C02.result, '未実施'); // ① が期待値に見つからないので 1 / 2
  const sheet = s.gas.sheet('自己テスト');
  const c01Row = sheet.text().findIndex((x) => x[0] === 'C01') + 1;
  assert.equal(sheet.fontColor[c01Row + ',4'], '#c62828');
  assert.equal(sheet.fontColor['2,4'], '#000000');
});

test('行が 1 つ多い・少ない: × で、詳細に「行の数」の違いが出る', () => {
  for (const [label, fn] of [['多い', (x) => x + '2026-10,2026-10-09,A-9,増やした行,1,1,x.csv,9\n'], ['少ない', (x) => x.split('\n').filter((l) => !l.includes('A-1016')).join('\n')]]) {
    const s = setup({ sync: true, mutate: (t) => editText(t, '01-basic/expected/details.csv', fn) });
    s.run();
    const r = results(s.gas);
    assert.equal(r.C01.result, '×', label);
    assert.match(r.C01.detail, /明細 行の数: 期待「1[35]」実際「14」/, label);
  }
});

test('期待値のファイルがない・見出しだけ・Google 形式: その項目が未実施で、全体は「すべて合格」にならない', () => {
  const cases = [
    ['ない', (t) => removeFile(t, '01-basic/expected/summary.csv'), true, /期待値のファイルがありません: 01-basic\/expected\/summary.csv|01-basic\/expected\/summary.csv がありません/],
    ['見出しだけ', (t) => editText(t, '01-basic/expected/monthly.csv', (x) => x.split('\n')[0] + '\n'), true, /期待値が見出しだけです: 01-basic\/expected\/monthly.csv/],
    ['Google 形式', (t) => { fileIn(t, '01-basic/expected/files.csv').file.mimeType = 'application/vnd.google-apps.spreadsheet'; }, true, /Google 形式に変わっています/],
  ];
  for (const [label, mutate, sync, re] of cases) {
    const s = setup({ mutate, sync });
    s.run();
    const r = results(s.gas);
    assert.equal(r.C01.result, '未実施', label);
    assert.match(r.C01.detail, re, label);
    assert.notEqual(r['0'].result, 'すべて合格', label);
  }
});

test('空のものと比べて ○ にならない: =SUM(1,2) の行を消すと C03、① の行を消すと C02、06 の明細を見出しだけにすると C19、input を 0 個にすると C07 が ○ にならない', () => {
  const sum = setup({ sync: true, mutate: (t) => removeLine(t, '01-basic/expected/details.csv', (l) => l.includes('=SUM(1,2)')) });
  sum.run();
  assert.equal(results(sum.gas).C03.result, '未実施');
  assert.match(results(sum.gas).C03.detail, /=SUM\(1,2\) の行が 0 行です/);

  // ① の行を「① のない商品」に変える（行を消すと後ろの行がずれて、㈱ の位置の比べ方が × になるため）
  const one = setup({ sync: true, mutate: (t) => editText(t, '01-basic/expected/details.csv', (x) => x.replace('ギフトセット ①', 'ギフトセット')) });
  one.run();
  assert.equal(results(one.gas).C02.result, '未実施');
  assert.match(results(one.gas).C02.detail, /確かめた 1 \/ 2/);

  const six = setup({ sync: true, mutate: (t) => editText(t, '06-sjis-fixed-decimal/expected/details.csv', (x) => x.split('\n')[0] + '\n') });
  six.run();
  assert.equal(results(six.gas).C19.result, '未実施');

  const empty = setup({ mutate: (t) => { treeFolder(t, '01-basic/input').files = []; } });
  empty.run();
  assert.notEqual(results(empty.gas).C07.result, '○');
  // CASE_FILES も合わせて 0 個にしても ○ にならない（C01 が止まり、C05 を実施できない）
  const emptySync = setup({ sync: true, mutate: (t) => { treeFolder(t, '01-basic/input').files = []; } });
  emptySync.run();
  assert.notEqual(results(emptySync.gas).C07.result, '○');
  assert.equal(results(emptySync.gas).C01.result, '×');
});

test('C02・C03 の数（任意 2）: ㈱ の行だけを消すと C02 が「確かめた 1 / 2」の未実施。=SUM(1,2) の行が 2 つなら C03 が未実施', () => {
  const s = setup({ sync: true, mutate: (t) => removeLine(t, '01-basic/expected/details.csv', (l) => l.includes('㈱')) });
  s.run();
  assert.equal(results(s.gas).C02.result, '未実施');
  assert.match(results(s.gas).C02.detail, /^実施できません: 確かめた 1 \/ 2$/);
  const two = setup({ sync: true, mutate: (t) => editText(t, '01-basic/expected/details.csv', (x) => x + '2026-10,2026-10-02,A-1015,"=SUM(1,2)",1,100,c_2026-09-to-10.csv,7\n') });
  two.run();
  assert.equal(results(two.gas).C03.result, '未実施');
  assert.match(results(two.gas).C03.detail, /2 行です/);
});

test('何もせずに止まった集計: ?usp の形を読めない extractFolderId で C13 が ×（status と作り直し）', () => {
  const s = setup();
  const orig = s.ctx.extractFolderId;
  s.ctx.extractFolderId = (v) => (/\?usp=/.test(String(v)) ? '' : orig(v));
  s.run();
  const r = results(s.gas);
  assert.equal(r.C12.result, '○');
  assert.equal(r.C13.result, '×');
  assert.match(r.C13.detail, /status が「stopped」（期待「success」）/);
  assert.match(r.C13.detail, /作り直されていません/);
  assert.ok(!r.C13.detail.includes('drive.google.com'), r.C13.detail);
});

test('何もせずに止まった集計: 2 回目の getScriptLock だけ取れないと C05 が ×。C17 の 2 回目だけ止まると C17 が ×', () => {
  const s = setup({ options: { lock: (n) => n !== 2 } });
  s.run();
  assert.equal(results(s.gas).C01.result, '○');
  assert.equal(results(s.gas).C05.result, '×');
  assert.match(results(s.gas).C05.detail, /他の集計が実行中です/);

  const t = setup();
  let inC17 = false;
  let calls = 0;
  wrapPlan(t.gas, 'C17', (c, orig) => { inC17 = true; try { return orig(c); } finally { inC17 = false; } });
  const aggregate = t.ctx.aggregateWith_;
  t.ctx.aggregateWith_ = (clock, settings) => {
    if (inC17 && ++calls === 2) return { status: 'stopped', message: '止めました（モック）' };
    return aggregate(clock, settings);
  };
  t.run();
  assert.equal(results(t.gas).C17.result, '×');
  assert.match(results(t.gas).C17.detail, /空白だけ: status が「stopped」/);
});

test('止まるはずが変わった: findForeignOutputSheet_ を壊すと C10 が ×（stopped でない、ID が変わる）', () => {
  const s = setup();
  s.ctx.findForeignOutputSheet_ = () => null;
  s.run();
  const r = results(s.gas);
  assert.equal(r.C10.result, '×');
  assert.match(r.C10.detail, /status が「success」（期待「stopped」）/);
});

test('C10・C18 の控えるタイミング（任意 1）: 止まったあとに出力の名前のシートが 1 つ増えると、C10・C18 が ×', () => {
  const s = setup();
  const aggregate = s.ctx.aggregateWith_;
  const ss = s.ctx.SpreadsheetApp.getActiveSpreadsheet();
  let added = null;
  s.ctx.aggregateWith_ = (clock, settings) => {
    const result = aggregate(clock, settings);
    if (result.status === 'stopped') {
      added = s.ctx.OUTPUT_SHEETS.find((n) => !ss.getSheetByName(n));
      ss.insertSheet(added).getRange(1, 1, 1, s.ctx.OUTPUT_HEADERS[added].length).setValues([s.ctx.OUTPUT_HEADERS[added]]);
    }
    return result;
  };
  // 足したシートは項目のあとで消す（次の項目に持ち越さない）
  for (const id of ['C10', 'C18']) {
    wrapPlan(s.gas, id, (c, orig) => { try { return orig(c); } finally { if (added && ss.getSheetByName(added)) ss.deleteSheet(ss.getSheetByName(added)); added = null; } });
  }
  s.run();
  const r = results(s.gas);
  assert.equal(r.C10.result, '×');
  assert.match(r.C10.detail, /止まるはずがシートが増えました/);
  assert.equal(r.C18.result, '×');
  assert.match(r.C18.detail, /止まるはずがシートが増えました/);
});

test('確かめた数が足りなければ未実施、多ければ ×（項目の関数が ctx.check を飛ばす・増やす）', () => {
  const s = setup();
  wrapPlan(s.gas, 'C04', (c) => { c.expect(2); c.check('1 つ目', true); });
  wrapPlan(s.gas, 'C12', (c) => { c.expect(2); c.check('1', true); c.check('2', true); c.check('3', true); });
  s.run();
  const r = results(s.gas);
  assert.equal(r.C04.result, '未実施');
  assert.equal(r.C04.detail, '実施できません: 確かめた 1 / 2');
  assert.equal(r.C12.result, '×');
  assert.equal(r.C12.detail, '自己テストのコードの誤り: 確かめた 3 / 2');
  assert.equal(r['0'].result, '不合格');
});

test('settings.json が壊れている: そのケースの項目が未実施', () => {
  const s = setup({ sync: true, mutate: (t) => editText(t, '03-no-dedupe/settings.json', () => '{ 壊れた') });
  s.run();
  const r = results(s.gas);
  for (const id of ['C12', 'C13']) {
    assert.equal(r[id].result, '未実施', id);
    assert.match(r[id].detail, /03-no-dedupe\/settings.json を JSON として読めません/);
  }
  assert.equal(r.C14.result, '○');
  assert.equal(r['0'].result, '未完了');
});

test('ファイルが足りない・大きさが違う（4.4）: input・expected・settings.json のどれでも、そのケースの項目が未実施で、全体の文は「押し直しても実施できません」', () => {
  const cases = [
    ['input が足りない', (t) => removeFile(t, '04-unclosed-one-file/input/a_ok.csv'), ['C14'], /04-unclosed-one-file\/input\/a_ok.csv がありません/],
    ['expected の大きさ（改行コード）', (t) => editText(t, '06-sjis-fixed-decimal/expected/files.csv', (x) => x.replace(/\r\n/g, '\n')), ['C19'], /06-sjis-fixed-decimal\/expected\/files.csv の大きさ（期待 143、実際 140）/],
    ['settings.json の大きさ', (t) => editText(t, '05-stray-quotes/settings.json', (x) => x + ' '), ['C15', 'C16', 'C17', 'C18'], /05-stray-quotes\/settings.json の大きさ（期待 209、実際 210）/],
    ['多い', (t) => treeFolder(t, '03-no-dedupe/input').files.push({ name: 'extra.csv', bytes: Buffer.from('x') }), ['C12', 'C13'], /03-no-dedupe\/input\/extra.csv は手元のケースにありません/],
  ];
  for (const [label, mutate, ids, re] of cases) {
    const s = setup({ mutate });
    s.run();
    const r = results(s.gas);
    for (const id of ids) {
      assert.equal(r[id].result, '未実施', label + ' ' + id);
      assert.match(r[id].detail, /^実施できません: ドライブのファイルが手元のケースと違います: /, label);
      assert.match(r[id].detail, re, label);
    }
    assert.equal(r['0'].result, '未完了', label);
    assert.match(r['0'].detail, /押し直しても実施できません/, label);
    assert.match(s.gas.calls.alerts[0], /この画面を送ってください\nM01・M02 はまだ書かないでください。$/, label);
    assert.doesNotMatch(s.gas.calls.alerts[0], /M01・M02 を書いてから/, label);
  }
});

test('使うケースが違う（推奨 4）: 01 の input の 1 ファイルの大きさを変えると C01〜C11 が未実施（C11 も × にならない）。C12 以降と C20・C21 は流れる', () => {
  const s = setup({ mutate: (t) => editText(t, '01-basic/input/b_2026-09.csv', (x) => x + '\n') });
  s.run();
  const r = results(s.gas);
  for (const p of st.SELFTEST_PLAN) {
    if (p.cases.includes('01-basic')) {
      assert.equal(r[p.id].result, '未実施', p.id);
      assert.match(r[p.id].detail, /01-basic\/input\/b_2026-09.csv の大きさ/, p.id);
    } else if (p.kind === '判定') {
      assert.equal(r[p.id].result, '○', p.id);
    }
  }
  assert.equal(r.C21.result, '記録');
  assert.match(cellOf(s.gas, 'M01', 3), /ドライブのケースが手元と違うので書けません/);
});

test('使うケースが違う（推奨 3）: 2 回目の前にだけ 03 のファイルを変えると、2 回目の C12・C13 が未実施（回ごとに確かめる）', () => {
  const s = setup();
  advanceAfter(s, 'C11');
  s.run();
  assert.equal(results(s.gas).C12.result, '未実施');
  assert.match(results(s.gas).C12.detail, /^時間:/);
  editText(s.tree, '03-no-dedupe/input/p_week1.csv', (x) => x + '\n');
  s.clock.t += 1 * MIN;
  s.run();
  const r = results(s.gas);
  assert.equal(r.C12.result, '未実施');
  assert.match(r.C12.detail, /03-no-dedupe\/input\/p_week1.csv の大きさ/);
  assert.equal(r.C13.result, '未実施');
  assert.equal(r.C12.run, '2');
  assert.equal(r.C14.result, '○');
});

test('項目の中で例外: その項目が × で、次の項目は流れる', () => {
  const s = setup();
  wrapPlan(s.gas, 'C12', () => { throw new Error('わざとの例外'); });
  s.run();
  const r = results(s.gas);
  assert.equal(r.C12.result, '×');
  assert.equal(r.C12.detail, '例外: わざとの例外');
  assert.equal(r.C13.result, '○');
  // setValues の失敗（モックの fail.setValuesAt）も同じ。C12 の中の最初の setValues を数えて失敗させる
  const probe = setup();
  let inC12 = false;
  let at = 0;
  wrapPlan(probe.gas, 'C12', (c, orig) => { inC12 = true; try { return orig(c); } finally { inC12 = false; } });
  const setValuesBefore = probe.ctx.aggregateWith_;
  probe.ctx.aggregateWith_ = (clock, settings) => { if (inC12 && !at) at = probe.gas.calls.setValues + 1; return setValuesBefore(clock, settings); };
  probe.run();
  assert.ok(at > 0);
  const f = setup({ options: { fail: { setValuesAt: at } } });
  f.run();
  const fr = results(f.gas);
  const failed = JUDGED.filter((id) => fr[id].result === '×');
  assert.deepEqual(failed, ['C12']);
  assert.match(fr[failed[0]].detail, /setValues に失敗しました（モック）/);
});

test('本番のコードを壊す: 明細の textCols を空にし、FORMULA_GUARD も false にすると C03・C20 が ×。textCols だけを空にしても \' で守られて ○', () => {
  const both = setup();
  both.ctx.OUTPUT_LAYOUT['明細'].textCols = [];
  both.ctx.FORMULA_GUARD = false;
  both.run();
  const r = results(both.gas);
  assert.equal(r.C03.result, '×');
  assert.match(r.C03.detail, /明細 D13 が数式です/);
  assert.equal(r.C20.result, '×');
  assert.equal(r.C01.result, '×');
  // textCols だけを空にした場合（本物の Sheets でも ' が先頭にあれば数式にならない見込み。モックは ' を残す）
  const cols = setup();
  cols.ctx.OUTPUT_LAYOUT['明細'].textCols = [];
  cols.run();
  assert.equal(results(cols.gas).C03.result, '○');
  assert.equal(results(cols.gas).C20.result, '○');
});

test('本番のコードを壊す: FORMULA_GUARD を false にしても C01 の比べ方は壊れない（守ったセルがなくなるだけ）', () => {
  const s = setup();
  s.ctx.FORMULA_GUARD = false;
  s.run();
  const r = results(s.gas);
  assert.equal(r['0'].result, 'すべて合格', JSON.stringify(r['0']));
  assert.match(r.C03.detail, /書いた値「=SUM\(1,2\)」、守ったセル ' あり 0・なし 0/);
  assert.match(cellOf(s.gas, 'I03', 5), /FORMULA_GUARD=false/);
});

test('SJIS_CHARSET を戻す: C08 の途中で例外にしても、後で windows-31j に戻り、C09 以降は流れる', () => {
  const s = setup();
  const aggregate = s.ctx.aggregateWith_;
  s.ctx.aggregateWith_ = (clock, settings) => {
    if (s.ctx.SJIS_CHARSET === 'Shift_JIS') throw new Error('C08 の途中の例外');
    return aggregate(clock, settings);
  };
  s.run();
  const r = results(s.gas);
  assert.equal(r.C08.result, '×');
  assert.equal(r.C08.detail, '例外: C08 の途中の例外');
  assert.equal(s.ctx.SJIS_CHARSET, 'windows-31j');
  assert.equal(r.C09.result, '○');
});

test('SJIS_CHARSET を Shift_JIS にしてもエラーにならない本番（変換の検査を壊す）なら、C08 が × で ① の文字のコードが出る', () => {
  const s = setup();
  s.ctx.findReplacementCharLine = () => 0;
  s.run();
  const r = results(s.gas);
  assert.equal(r.C08.result, '×');
  assert.match(r.C08.detail, /明細の ① の位置の文字: U\+FFFD/);
});

test('I02・I03 は回の始めの値（任意 4）: C08 の途中で結果のシートを書いても、I03 は SJIS_CHARSET=windows-31j のまま', () => {
  const s = setup();
  let seen = null;
  wrapPlan(s.gas, 'C08', (c, orig) => {
    const aggregate = s.ctx.aggregateWith_;
    s.ctx.aggregateWith_ = (clock, settings) => {
      assert.equal(s.ctx.SJIS_CHARSET, 'Shift_JIS');
      s.ctx.selfTestWrite_(c.run);
      seen = cellOf(s.gas, 'I03', 5);
      return aggregate(clock, settings);
    };
    try { return orig(c); } finally { s.ctx.aggregateWith_ = aggregate; }
  });
  s.run();
  assert.match(seen, /^SJIS_CHARSET=windows-31j \//);
  assert.equal(results(s.gas).C08.result, '○');
});

// =====================================================================
// 時間切れと続き（6.5・6.6）
// =====================================================================
test('時間切れと組 G1: C05 の前で 4 分を超えると C05 以降が未実施で「未完了」。もう一度押すと C01 からやり直して「すべて合格」、C01〜C07 の回が 2', () => {
  const s = setup();
  const adv = advanceAfter(s, 'C04');
  s.run();
  let r = results(s.gas);
  assert.equal(r['0'].result, '未完了');
  assert.match(r['0'].detail, /^未実施 \d+ 件。もう一度「自己テスト（開発用）」を押すと続きから実施します$/);
  assert.equal(r.C04.result, '○');
  for (const id of ['C05', 'C07', 'C08', 'C21']) assert.equal(r[id].detail, '時間: 時間が足りないので、ここで止めました', id);
  assert.equal(r.C06.result, '未実施');
  // 最後の画面の文（監査 推奨 1）: 「未完了」のときは M01・M02 を書いて送るように言わない
  assert.match(s.gas.calls.alerts[0], /^自己テストの結果: 未完了。未実施 \d+ 件。もう一度「自己テスト（開発用）」を押すと続きから実施します\nM01・M02 はまだ書かないでください。$/);
  adv.off();
  s.clock.t += 1 * MIN;
  s.run();
  r = results(s.gas);
  assert.equal(r['0'].result, 'すべて合格', r['0'].detail);
  assert.match(s.gas.calls.alerts[s.gas.calls.alerts.length - 1], /\nM01・M02 を書いてから「自己テスト」シートを送ってください。$/);
  for (const id of ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C21']) assert.equal(r[id].run, '2', id);
  assert.equal(cellOf(s.gas, 'I01', 5), '1=2026-10-18 10:02 / 2=2026-10-18 10:08');
  assert.equal(cellOf(s.gas, 'I04', 5), 'G1=1 / G2=0 / 2 回目: C01 から（C01 と同じ回に C05 を実施できなかったため）');
});

test('時間切れ（組の外）: C12 の前で止めると、続きは C12 から（C01〜C11 の回は 1 のまま）。C18 だけ残すと C17 から（G2）', () => {
  const s = setup();
  advanceAfter(s, 'C11');
  s.run();
  s.clock.t += 1 * MIN;
  s.run();
  let r = results(s.gas);
  assert.equal(r['0'].result, 'すべて合格');
  for (const id of ['C01', 'C07', 'C10', 'C11']) assert.equal(r[id].run, '1', id);
  for (const id of ['C12', 'C13', 'C21']) assert.equal(r[id].run, '2', id);
  assert.equal(cellOf(s.gas, 'I04', 5), 'G1=0 / G2=0 / 2 回目: 続きから');

  const g = setup();
  const gAdv = advanceAfter(g, 'C17');
  g.run();
  assert.equal(results(g.gas).C17.result, '○');
  assert.match(results(g.gas).C18.detail, /^時間:/);
  gAdv.off();
  g.clock.t += 1 * MIN;
  g.run();
  r = results(g.gas);
  assert.equal(r['0'].result, 'すべて合格');
  assert.equal(r.C17.run, '2');
  assert.equal(r.C18.run, '2');
  assert.equal(r.C16.run, '1');
  assert.match(cellOf(g.gas, 'I04', 5), /^G1=0 \/ G2=1 \/ 2 回目: C17 から（C17 と同じ回に C18 を実施できなかったため）$/);
});

test('組が収まらない: G1 の途中で 2 回続けて時間切れにすると、3 回目は G1 の残りが「実施できません」で、全体の文が「押し直しても実施できません」', () => {
  const s = setup();
  advanceAfter(s, 'C04');
  s.run();
  s.clock.t += 1 * MIN;
  s.run();
  assert.equal(cellOf(s.gas, 'I04', 5).slice(0, 12), 'G1=1 / G2=0 ');
  // I04 の文を変えても、数で決まる（任意 3）
  setCell(s.gas, 'I04', 5, 'G1=1 / G2=0 / 文を書き換えた');
  s.clock.t += 1 * MIN;
  s.run();
  const r = results(s.gas);
  for (const id of ['C05', 'C07']) {
    assert.equal(r[id].result, '未実施', id);
    assert.equal(r[id].detail, '実施できません: G1 が 1 回の実行の時間に収まりません。この画面を送ってください', id);
  }
  assert.equal(r.C04.result, '○');
  assert.equal(r.C21.result, '記録');
  assert.equal(r['0'].result, '未完了');
  assert.match(r['0'].detail, /押し直しても実施できません/);
});

test('強制的に止められた: 「実行中」を残した結果から呼ぶと、その項目が × で、同じ組の残りが「実施できません」', () => {
  const s = setup();
  const sAdv = advanceAfter(s, 'C04');
  s.run();
  setCell(s.gas, 'C05', 4, '実行中');
  sAdv.off();
  s.clock.t += 1 * MIN;
  s.run();
  const r = results(s.gas);
  assert.equal(r.C05.result, '×');
  assert.equal(r.C05.detail, '6 分の上限で止まった可能性があります');
  assert.equal(r.C05.run, '1');
  assert.equal(r.C07.result, '未実施');
  assert.equal(r.C07.detail, '実施できません: 同じ組の C05 が途中で止まったため');
  assert.equal(r.C08.result, '○');
  assert.equal(r['0'].result, '不合格');
});

test('C10 の残り（推奨 5）: C10 の途中で止まって空の「明細」が残っても、始めに消えて C11 以降が ○。1 行目に何かある「明細」は消さない', () => {
  const s = setup();
  const sAdv = advanceAfter(s, 'C09');
  s.run();
  const ss = s.ctx.SpreadsheetApp.getActiveSpreadsheet();
  ss.insertSheet('明細'); // C10 が作った直後に強制的に止められた状態のまね
  setCell(s.gas, 'C10', 4, '実行中');
  sAdv.off();
  s.clock.t += 1 * MIN;
  s.run();
  const r = results(s.gas);
  assert.equal(r.C10.result, '×');
  for (const id of ['C11', 'C12', 'C19']) assert.equal(r[id].result, '○', id);

  const keep = setup({ options: { sheets: { '明細': [['依頼者のメモ']] } } });
  keep.run();
  assert.deepEqual(keep.gas.sheet('明細').text(), [['依頼者のメモ']]);
  assert.equal(results(keep.gas).C10.result, '未実施');
  assert.equal(results(keep.gas).C01.result, '×');
});

test('続きの条件（必須 2）: 版・60 分・名前・FORMULA_GUARD・SJIS_CHARSET・ケースのフォルダの ID・関数の中身・var の値のどれが変わっても最初からやり直し、I04 に理由が出る', () => {
  const changes = [
    ['版', (s) => { s.ctx.SELFTEST_VERSION = '2026-10-20'; }, /^G1=0 \/ G2=0 \/ 自己テストの版が変わったので最初から実施（2026-10-19 → 2026-10-20）$/],
    ['60 分', (s) => { s.clock.t += 61 * MIN; }, /前回から 60 分を過ぎたので最初から実施/],
    ['名前', (s) => { s.opts.name = '自己テスト_別の名前'; }, /スプレッドシートの名前が変わったので最初から実施/],
    ['FORMULA_GUARD', (s) => { s.ctx.FORMULA_GUARD = false; }, /定数が変わったので最初から実施（FORMULA_GUARD: true → false/],
    ['SJIS_CHARSET', (s) => { s.ctx.SJIS_CHARSET = 'MS932'; }, /定数が変わったので最初から実施（SJIS_CHARSET: windows-31j → MS932/],
    ['ケースのフォルダ', (s) => { s.tree.id = 'CasesFolder0099'; }, /定数が変わったので最初から実施（ケースのフォルダ: [0-9a-f]{8} → [0-9a-f]{8}）/],
    ['main.js の関数', (s) => { vm.runInContext(s.ctx.numberFormatFor.toString().replace('{', '{ /* 変えた */'), s.ctx); }, /定数が変わったので最初から実施（コード: [0-9a-f]{8} → [0-9a-f]{8}）/],
    ['selftest.js の関数', (s) => { vm.runInContext(s.ctx.selfTestC21_.toString().replace('{', '{ /* 変えた */'), s.ctx); }, /（コード: /],
    ['lib.js の関数', (s) => { vm.runInContext(s.ctx.TrimText.toString().replace('{', '{ /* 変えた */'), s.ctx); }, /（コード: /],
    ['var の値', (s) => { s.ctx.COLOR_INPUT = '#fff8c6'; }, /（コード: /],
  ];
  for (const [label, change, re] of changes) {
    const s = setup();
    const sAdv = advanceAfter(s, 'C11');
    s.run();
    assert.equal(results(s.gas)['0'].result, '未完了', label);
    sAdv.off();
    s.clock.t += 1 * MIN;
    change(s);
    s.run();
    const r = results(s.gas);
    assert.match(cellOf(s.gas, 'I04', 5), re, label);
    assert.equal(r.C01.run, '1', label);
    assert.equal(cellOf(s.gas, 'I01', 5).split(' / ').length, 1, label);
    assert.ok(['すべて合格', '不合格', '未完了'].includes(r['0'].result), label);
  }
});

test('続きの条件: 前回も今回もコードの指紋が取れない（toString がソースを返さない）ときは、ほかの条件だけで続きになり、I04 に「比べていません」。片方だけなら最初から', () => {
  const s = setup();
  vm.runInContext('Function.prototype.toString = function () { return "function () { [native code] }"; };', s.ctx);
  const sAdv = advanceAfter(s, 'C11');
  s.run();
  assert.match(cellOf(s.gas, 'I03', 5), / \/ コード=取れません$/);
  sAdv.off();
  s.clock.t += 1 * MIN;
  s.run();
  assert.equal(results(s.gas).C01.run, '1');
  assert.equal(results(s.gas).C12.run, '2');
  assert.match(cellOf(s.gas, 'I04', 5), /コードの指紋は取れないので比べていません/);

  const half = setup();
  const halfAdv = advanceAfter(half, 'C11');
  half.run();
  halfAdv.off();
  vm.runInContext('Function.prototype.toString = function () { return "function () { [native code] }"; };', half.ctx);
  half.clock.t += 1 * MIN;
  half.run();
  assert.match(cellOf(half.gas, 'I04', 5), /（コード: [0-9a-f]{8} → 取れません）/);
});

test('I01 の形（任意 3）: 日付をまたいでも（23:58 と 00:03）60 分以内なら続き。I01 が読めない形なら最初から', () => {
  const s = setup();
  s.clock.t = Date.UTC(2026, 9, 18, 14, 58); // 23:58（日本時間）
  advanceAfter(s, 'C11');
  s.run();
  s.clock.t = Date.UTC(2026, 9, 18, 15, 3); // 翌日の 00:03
  s.run();
  assert.equal(cellOf(s.gas, 'I01', 5), '1=2026-10-18 23:58 / 2=2026-10-19 00:03');
  assert.equal(results(s.gas)['0'].result, 'すべて合格');

  const bad = setup();
  const badAdv = advanceAfter(bad, 'C11');
  bad.run();
  setCell(bad.gas, 'I01', 5, '1 回目 10:02');
  badAdv.off();
  bad.clock.t += 1 * MIN;
  bad.run();
  assert.match(cellOf(bad.gas, 'I04', 5), /前回の実行の時刻を読めないので最初から実施/);
});

test('前回が最後まで終わっていれば、もう一度押すと最初から（回は 1）', () => {
  const s = setup();
  s.run();
  s.clock.t += 1 * MIN;
  s.run();
  assert.match(cellOf(s.gas, 'I04', 5), /前回は最後まで実施したので最初から実施/);
  assert.equal(cellOf(s.gas, 'I01', 5), '1=2026-10-18 10:03');
});

test('M 行の書き込み（推奨 6）: 続きなら M01 の書き込みが残る。作り直しになるときに書き込みがあれば、シートを変えずに止まる', () => {
  const s = setup();
  const sAdv = advanceAfter(s, 'C11');
  s.run();
  setCell(s.gas, 'M01', 5, '(1) ① 設定シートを作る・② 集計する');
  sAdv.off();
  s.clock.t += 1 * MIN;
  s.run();
  assert.equal(cellOf(s.gas, 'M01', 5), '(1) ① 設定シートを作る・② 集計する');
  assert.equal(results(s.gas)['0'].result, 'すべて合格');

  // 最後まで終わったあとに書いて、もう一度押す（作り直しになる）
  setCell(s.gas, 'M02', 5, '承認画面の文');
  const before = s.gas.sheet('自己テスト').text();
  const names = s.gas.sheetNames();
  s.clock.t += 1 * MIN;
  const out = s.run();
  assert.equal(out.status, 'manualWritten');
  assert.deepEqual(s.gas.sheet('自己テスト').text(), before);
  assert.deepEqual(s.gas.sheetNames(), names);
  assert.equal(s.gas.calls.alerts[s.gas.calls.alerts.length - 1], s.ctx.SELFTEST_MANUAL_STOP_MESSAGE);

  // 版を変えた場合も同じ。空白だけなら空とみなして作り直す
  setCell(s.gas, 'M01', 5, '');
  setCell(s.gas, 'M02', 5, ' 　');
  s.ctx.SELFTEST_VERSION = '2026-10-19';
  assert.equal(s.run().status, 'done');
  assert.equal(cellOf(s.gas, 'M02', 5), '');
});

// =====================================================================
// 純粋関数
// =====================================================================
test('columnLetter: 1 → A、26 → Z、27 → AA、52 → AZ、53 → BA', () => {
  assert.deepEqual([1, 4, 26, 27, 52, 53, 702, 703].map(st.columnLetter), ['A', 'D', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
});

test('compareTables: 一致・セルの違い・行と列の数の違い・守ったセルの \' あり・なし', () => {
  const same = st.compareTables([['a', 'b'], ['1', '2']], [['a', 'b'], ['1', '2']]);
  assert.deepEqual(same, { expectedCount: 4, compared: 4, diffs: [], guardedWithQuote: 0, guardedWithoutQuote: 0 });
  const diff = st.compareTables([['a', 'b'], ['1', '2']], [['a', 'b'], ['1', '3']], { name: '明細' });
  assert.deepEqual(diff.diffs, [{ cell: '明細 B2', expected: '2', actual: '3' }]);
  const rows = st.compareTables([['a'], ['b']], [['a']], { name: '集計' });
  assert.deepEqual(rows.diffs, [{ cell: '集計 行の数', expected: '2', actual: '1' }]);
  assert.equal(rows.compared, 1);
  const cols = st.compareTables([['a', 'b']], [['a']]);
  assert.deepEqual(cols.diffs, [{ cell: '1 行目の列の数', expected: '2', actual: '1' }]);
  const guarded = { '2,1': true, '3,1': true };
  const g = st.compareTables([['x'], ["'=A"], ["'=B"]], [['x'], ["'=A"], ['=B']], { guarded });
  assert.deepEqual([g.diffs, g.guardedWithQuote, g.guardedWithoutQuote], [[], 1, 1]);
  // 守っていないセルでは ' の有無は違い
  const notGuarded = st.compareTables([['x'], ["'=A"]], [['x'], ['=A']]);
  assert.equal(notGuarded.diffs.length, 1);
  // 守ったセルでも、別の値（数式の計算の結果など）は違い
  assert.equal(st.compareTables([["'=SUM(1,2)"]], [['3']], { guarded: { '1,1': true } }).diffs.length, 1);
  // 期待値のセルの数が 0 なら、itemResult で未実施
  const empty = st.compareTables([], []);
  assert.equal(empty.expectedCount, 0);
  assert.deepEqual(st.itemResult(empty.expectedCount, [{ name: '表', count: empty.compared, ok: true }]), { result: '未実施', detail: '実施できません: 確かめる数が 0 です' });
});

test('itemResult: 5 章の冒頭の 5 つの決まり', () => {
  assert.deepEqual(st.itemResult(0, []), { result: '未実施', detail: '実施できません: 確かめる数が 0 です' });
  assert.deepEqual(st.itemResult(5, [{ name: 'a', ok: true }, { name: '表', count: 2, ok: true }]), { result: '未実施', detail: '実施できません: 確かめた 3 / 5' });
  assert.deepEqual(st.itemResult(3, [{ name: 'a', ok: true }, { name: '表', count: 2, ok: true }]), { result: '○', detail: '確かめた 3 / 3' });
  assert.deepEqual(st.itemResult(5, [{ name: 'a', ok: false, detail: '違う' }]), { result: '×', detail: '確かめた 1 / 5。違う' });
  assert.deepEqual(st.itemResult(2, [{ name: 'a', ok: true }, { name: 'b', ok: true }, { name: 'c', ok: true }]), { result: '×', detail: '自己テストのコードの誤り: 確かめた 3 / 2' });
  const t = st.itemResult(4, [{ name: '表', count: 4, ok: false, diffs: [{ cell: 'D4', expected: '①', actual: '?' }] }]);
  assert.deepEqual(t, { result: '×', detail: '確かめた 4 / 4。D4: 期待「①」実際「?」' });
});

test('formatDiffs: 3 か所まで、ほかは「ほか n か所」、1 か所 120 文字まで、改行は \\n', () => {
  const d = [1, 2, 3, 4, 5].map((i) => ({ cell: 'A' + i, expected: 'x', actual: 'y' }));
  assert.equal(st.formatDiffs(d, 3), 'A1: 期待「x」実際「y」。A2: 期待「x」実際「y」。A3: 期待「x」実際「y」。ほか 2 か所');
  const long = st.formatDiffs([{ text: 'あ'.repeat(200) }], 3);
  assert.equal(long.length, 120);
  assert.equal(st.formatDiffs([{ cell: 'D11', expected: 'ギフトセット\n（のし付き）', actual: 'x' }]), 'D11: 期待「ギフトセット\\n（のし付き）」実際「x」');
});

test('rebuiltCheck: 作り直し（ID が全部新しい）と、止まる側（名前・ID・値が同じ。増えたら ×、数は増やさない）', () => {
  const before = [{ name: '明細', id: 1, values: [['a', 'b']] }];
  assert.deepEqual(st.itemResult(1, st.rebuiltCheck(before, [{ name: '明細', id: 2, values: [] }], false)).result, '○');
  const same = st.itemResult(1, st.rebuiltCheck(before, [{ name: '明細', id: 1, values: [] }], false));
  assert.deepEqual(same, { result: '×', detail: '確かめた 1 / 1。作り直されていません: 明細' });
  // 止まる側: 1（ID）＋ 2（セル）
  assert.equal(st.itemResult(3, st.rebuiltCheck(before, [{ name: '明細', id: 1, values: [['a', 'b']] }], true)).result, '○');
  assert.equal(st.itemResult(3, st.rebuiltCheck(before, [{ name: '明細', id: 1, values: [['a', 'c']] }], true)).result, '×');
  assert.match(st.itemResult(3, st.rebuiltCheck(before, [{ name: '明細', id: 9, values: [['a', 'b']] }], true)).detail, /止まるはずが作り直されました: 明細/);
  const grown = st.itemResult(3, st.rebuiltCheck(before, [{ name: '明細', id: 1, values: [['a', 'b']] }, { name: '集計', id: 5, values: [] }], true));
  assert.equal(grown.result, '×');
  assert.match(grown.detail, /^確かめた 3 \/ 3。止まるはずがシートが増えました: 集計$/);
  assert.equal(st.itemResult(3, st.rebuiltCheck(before, [], true)).result, '×');
});

test('expectedWithGuard: 2 行目以降の文字の列だけ toSheetText を通し、変わったセルを守ったセルにする', () => {
  const tst = (v, guard) => (guard && /^[=+\-@]/.test(v) ? "'" + v : v);
  const out = st.expectedWithGuard([['=見出し', 'x'], ['=a', '-1'], ['b', '+c']], [1], true, tst);
  assert.deepEqual(out.rows, [['=見出し', 'x'], ["'=a", '-1'], ['b', '+c']]);
  assert.deepEqual(out.guarded, { '2,1': true });
  assert.deepEqual(st.expectedWithGuard([['h'], ['=a']], [1], false, tst).guarded, {});
});

test('overallResult: plan が空・結果が足りない・plan にない番号は「すべて合格」にしない。未実施の理由で文が分かれる', () => {
  const ok = { result: '○', detail: '' };
  assert.equal(st.overallResult(['C01'], { C01: ok }).result, 'すべて合格');
  assert.deepEqual(st.overallResult([], {}), { result: '不合格', detail: '自己テストのコードの誤り: 判定の項目がありません' });
  assert.match(st.overallResult(['C01', 'C02'], { C01: ok }).detail, /結果のない番号があります: C02/);
  assert.match(st.overallResult(['C01'], { C01: ok, C99: ok }).detail, /予定にない番号の結果があります: C99/);
  assert.notEqual(st.overallResult(['C01'], { C01: { result: '記録', detail: '' } }).result, 'すべて合格');
  const time = { result: '未実施', detail: '時間: まだ実施していません' };
  const other = { result: '未実施', detail: '実施できません: ドライブのファイルが手元のケースと違います: x' };
  assert.deepEqual(st.overallResult(['C01', 'C02'], { C01: ok, C02: time }), { result: '未完了', detail: '未実施 1 件。もう一度「自己テスト（開発用）」を押すと続きから実施します' });
  assert.deepEqual(st.overallResult(['C01', 'C02', 'C03'], { C01: time, C02: other, C03: ok }),
    { result: '未完了', detail: '未実施 2 件のうち 1 件は、押し直しても実施できません（例: ドライブの input が手元のケースと違う）。この画面を送ってください' });
  assert.deepEqual(st.overallResult(['C01', 'C02', 'C03'], { C01: { result: '×', detail: '' }, C02: time, C03: { result: '×', detail: '' } }),
    { result: '不合格', detail: '× が 2 件（番号: C01、C03）。未実施 1 件は、もう一度押すと続きから実施します' });
  assert.equal(st.overallResult(['C01'], { C01: { result: '実行中', detail: '' } }).result, '未完了');
});

test('buildSelfTestValues: 7 列の文字。M03 の E 列は決まった文、M01・M02 は渡した値を残す。example.com 以外のメールアドレスと URL は伏せる', () => {
  const values = st.buildSelfTestValues(
    [{ id: '0', kind: '全体', title: '全体の判定', result: '未完了', detail: 'x', seconds: 1.234, run: 1 },
      { id: 'C01', kind: '判定', title: 't', result: '×', detail: 'a@example.com と b@example.org、https://drive.google.com/drive/folders/abc（ID: abc）', seconds: '', run: 2 }],
    [{ id: 'M01', title: 'm1', detail: '書いた' }, { id: 'M03', title: 'm3', detail: '上書きされる' }],
    [{ id: 'I01', title: '実行', detail: '1=2026-10-18 10:02' }]);
  assert.deepEqual(values[0], st.SELFTEST_HEADERS);
  assert.deepEqual(values[1], ['0', '全体', '全体の判定', '未完了', 'x', '1.2', '1']);
  assert.equal(values[2][4], 'a@example.com と （メールアドレスは伏せました）、（URL は伏せました）（ID は伏せました）');
  assert.deepEqual(values[3], ['', '', '', '', '', '', '']);
  assert.deepEqual(values[4], ['M01', '手で確認', 'm1', '手で', '書いた', '', '']);
  assert.equal(values[5][4], st.SELFTEST_M03_TEXT);
  assert.deepEqual(values[7], ['I01', '情報', '実行', '', '1=2026-10-18 10:02', '', '']);
  assert.ok(values.every((r) => r.length === 7 && r.every((v) => typeof v === 'string')));
});

test('selfTestFinalMessage_（監査 推奨 1）: M01・M02 を書いて送るのは「すべて合格」と「不合格」のときだけ。「未完了」では「まだ書かない」', () => {
  const send = '\nM01・M02 を書いてから「自己テスト」シートを送ってください。';
  assert.equal(st.selfTestFinalMessage_({ result: 'すべて合格', detail: 'a' }), '自己テストの結果: すべて合格。a' + send);
  assert.equal(st.selfTestFinalMessage_({ result: '不合格', detail: 'b' }), '自己テストの結果: 不合格。b' + send);
  assert.equal(st.selfTestFinalMessage_({ result: '未完了', detail: 'c' }), '自己テストの結果: 未完了。c\nM01・M02 はまだ書かないでください。');
});

test('checkUploadedFiles: 足りない・多い・大きさ・Google 形式・同じ名前が 2 つ', () => {
  assert.deepEqual(st.checkUploadedFiles({ 'a/x': 1 }, [{ path: 'a/x', size: 1, mimeType: 'text/csv' }]), []);
  assert.deepEqual(st.checkUploadedFiles({ 'a/x': 1, 'a/y': 2, 'a/z': 3, 'a/w': 4 }, [
    { path: 'a/x', size: 9, mimeType: 'text/csv' },
    { path: 'a/z', size: 3, mimeType: 'application/vnd.google-apps.spreadsheet' },
    { path: 'a/w', size: 4 }, { path: 'a/w', size: 4 },
    { path: 'a/extra', size: 1 },
  ]), ['a/w が 2 つあります', 'a/x の大きさ（期待 1、実際 9）', 'a/y がありません', 'a/z が Google 形式に変わっています', 'a/extra は手元のケースにありません']);
});

test('codeFingerprint: 同じ入力で同じ 8 桁の 16 進、1 文字違えば違う値、区切りの位置も区別する', () => {
  const a = st.codeFingerprint(['abc', 'def']);
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(st.codeFingerprint(['abc', 'def']), a);
  assert.notEqual(st.codeFingerprint(['abc', 'deg']), a);
  assert.notEqual(st.codeFingerprint(['ab', 'cdef']), a);
  assert.notEqual(st.codeFingerprint(['あ']), st.codeFingerprint(['い']));
  assert.equal(st.codeFingerprint([]), '811c9dc5');
});

test('fingerprintSources（8.3 の 3・4）: モックのグローバルで ok が真。関数の本文や var の値を 1 文字変えると指紋が変わる。toString がソースを返さない・引けない関数・undefined の var なら ok が偽', () => {
  const gas = createGas({ settingsRows: null, withSelfTest: true });
  const c = gas.context;
  const lookup = (n) => c[n];
  const base = st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, lookup);
  assert.equal(base.ok, true);
  const print = st.codeFingerprint(base.sources);
  vm.runInContext(c.numberFormatFor.toString().replace("'#,##0'", "'#,##1'"), c);
  const changed = st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, lookup);
  assert.equal(changed.ok, true);
  assert.notEqual(st.codeFingerprint(changed.sources), print);
  const after = st.codeFingerprint(changed.sources);
  c.OUTPUT_LAYOUT['集計'].numberCols = [3];
  assert.notEqual(st.codeFingerprint(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, lookup).sources), after);

  const native = (n) => { const v = c[n]; if (typeof v !== 'function') return v; const f = function () {}; f.toString = () => 'function () { [native code] }'; return f; };
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, native).ok, false);
  const missing = (n) => (n === 'aggregateWith_' ? undefined : c[n]);
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, missing).ok, false);
  const noVar = (n) => (n === 'FORMULA_GUARD' ? undefined : c[n]);
  assert.equal(st.fingerprintSources(c.SELFTEST_FINGERPRINT_FUNCS, c.SELFTEST_FINGERPRINT_VARS, noVar).ok, false);
  const throws = () => { throw new Error('x'); };
  assert.equal(st.fingerprintSources(['a'], [], throws).ok, false);
});

test('fingerprintSources（8.3 の 4）: 1 つの関数を引けないと、I03 が「コード=取れません」になる（判定は変えない）', () => {
  const s = setup();
  delete s.ctx.numberFormatFor;
  s.ctx.numberFormatFor = 1; // 関数でない
  s.run();
  assert.match(cellOf(s.gas, 'I03', 5), / \/ コード=取れません$/);
});

test('resumePoint: 前回がない・形が違う・続き（carry と todo）', () => {
  const groups = [{ id: 'C01', group: 'G1' }, { id: 'C02', group: 'G1' }, { id: 'C03', group: '' }, { id: 'C04', group: '' }];
  const current = { version: 'v', spreadsheet: '自己テスト_x', constants: [['A', '1'], ['コード', 'abc']] };
  assert.deepEqual(st.resumePoint(null, 'v', '2026-10-18 10:10', current, groups), { fresh: true, reason: '' });
  const prev = [
    st.SELFTEST_HEADERS,
    ['C01', '判定', '', '○', '確かめた 1 / 1', '0.1', '1'],
    ['C02', '判定', '', '○', '確かめた 1 / 1', '0.1', '1'],
    ['C03', '判定', '', '×', '違う', '0.1', '1'],
    ['C04', '判定', '', '未実施', '時間: 時間が足りないので、ここで止めました', '', '1'],
    ['I01', '情報', '実行', '', '1=2026-10-18 10:02', '', ''],
    ['I02', '情報', '版', '', 'SELFTEST_VERSION=v / スプレッドシート=自己テスト_x', '', ''],
    ['I03', '情報', '定数', '', 'A=1 / コード=abc', '', ''],
    ['I04', '情報', 'やり直し', '', 'G1=0 / なし', '', ''],
  ];
  const r = st.resumePoint(prev, 'v', '2026-10-18 10:10', current, groups);
  assert.equal(r.fresh, false);
  assert.equal(r.run, 2);
  assert.deepEqual(r.todo, ['C04']);
  assert.deepEqual(Object.keys(r.carry), ['C01', 'C02', 'C03']);
  assert.equal(r.carry.C03.result, '×');
  assert.equal(r.restarts, 'G1=0 / 2 回目: 続きから');
  assert.equal(st.resumePoint(prev, 'v', '2026-10-18 11:03', current, groups).fresh, true);
  assert.equal(st.resumePoint(prev, 'v', '2026-10-18 11:02', current, groups).fresh, false);
  assert.equal(st.resumePoint(prev, 'v', '2026-10-18 10:01', current, groups).fresh, true); // 前回より前
  assert.match(st.resumePoint(prev.filter((x) => x[0] !== 'C02'), 'v', '2026-10-18 10:10', current, groups).reason, /形が違う/);
  assert.match(st.resumePoint(prev.map((x) => (x[0] === 'I04' ? ['I04', '', '', '', 'なし', '', ''] : x)), 'v', '2026-10-18 10:10', current, groups).reason, /やり直しの回数を読めない/);
});

// =====================================================================
// 指紋の一覧・CASE_FILES・静的
// =====================================================================
function topLevel(source, re) {
  const out = [];
  source.split(/\r\n|\r|\n/).forEach((line) => { const m = re.exec(line); if (m) out.push(m[1]); });
  return out;
}
const sources = () => FILES.map((f) => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]);
const diffNames = (want, have) => ({ 足りない: want.filter((n) => !have.includes(n)), 多い: have.filter((n) => !want.includes(n)) });

test('指紋の一覧（8.3 の 1）: 4 つのファイルの行頭の function と var が、SELFTEST_FINGERPRINT_FUNCS・VARS とちょうど同じで、名前の順。var 名前 = function の行がない', () => {
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
  assert.ok(st.SELFTEST_FINGERPRINT_FUNCS.includes('selfTestC01_') && st.SELFTEST_FINGERPRINT_FUNCS.includes('aggregateWith_') && st.SELFTEST_FINGERPRINT_FUNCS.includes('ParseCsv'));
  assert.ok(st.SELFTEST_FINGERPRINT_VARS.includes('CASE_FILES') && st.SELFTEST_FINGERPRINT_VARS.includes('SELFTEST_PLAN') && st.SELFTEST_FINGERPRINT_VARS.includes('OUTPUT_LAYOUT'));
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
  const all = vm.createContext({});
  ['selftest.js', 'main.js', 'gas-lib.js', 'lib.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), all));
  assert.equal(typeof all.aggregateWith_, 'function');
});

test('CASE_FILES: リポジトリの cases/*/input・expected・settings.json の名前とバイト数に一致する', () => {
  const want = {};
  for (const c of fs.readdirSync(CASES_DIR).sort()) {
    const files = {};
    for (const sub of ['input', 'expected']) {
      for (const n of fs.readdirSync(path.join(CASES_DIR, c, sub))) files[sub + '/' + n] = fs.statSync(path.join(CASES_DIR, c, sub, n)).size;
    }
    for (const n of fs.readdirSync(path.join(CASES_DIR, c))) {
      if (fs.statSync(path.join(CASES_DIR, c, n)).isFile()) files[n] = fs.statSync(path.join(CASES_DIR, c, n)).size;
    }
    want[c] = files;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(st.CASE_FILES)), want);
  assert.ok(Object.keys(want['01-basic']).includes('input/~$a_2026-08.csv'));
});

test('SELFTEST_PLAN: 21 項目、番号の順、cases と組が仕様 5.1・6.6 のとおり', () => {
  const p = Object.fromEntries(st.SELFTEST_PLAN.map((x) => [x.id, x]));
  assert.deepEqual(st.SELFTEST_PLAN.map((x) => x.id), Array.from({ length: 21 }, (_, i) => 'C' + String(i + 1).padStart(2, '0')));
  assert.deepEqual(st.SELFTEST_PLAN.filter((x) => x.kind === '記録').map((x) => x.id), ['C06', 'C21']);
  for (const id of ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10']) assert.deepEqual(p[id].cases, ['01-basic'], id);
  assert.deepEqual(p.C11.cases, ['01-basic', '02-errors']);
  for (const id of ['C12', 'C13']) assert.deepEqual(p[id].cases, ['03-no-dedupe']);
  assert.deepEqual(p.C14.cases, ['04-unclosed-one-file']);
  for (const id of ['C15', 'C16', 'C17', 'C18']) assert.deepEqual(p[id].cases, ['05-stray-quotes']);
  assert.deepEqual(p.C19.cases, ['06-sjis-fixed-decimal']);
  assert.deepEqual(p.C20.cases, []);
  assert.deepEqual(p.C21.cases, []);
  assert.deepEqual(st.SELFTEST_PLAN.filter((x) => x.group === 'G1').map((x) => x.id), ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07']);
  assert.deepEqual(st.SELFTEST_PLAN.filter((x) => x.group === 'G2').map((x) => x.id), ['C17', 'C18']);
  assert.equal(p.C06.by, 'C05');
});

test('メニュー: selftest.js を読んだときだけ「自己テスト（開発用）」が足される', () => {
  const s = setup();
  s.ctx.onOpen();
  assert.deepEqual(s.gas.calls.menu.items.map((x) => x[0]), ['① 設定シートを作る', '② 集計する', '自己テスト（開発用）']);
  const plain = createGas({ settingsRows: null });
  plain.context.onOpen();
  assert.deepEqual(plain.calls.menu.items.map((x) => x[0]), ['① 設定シートを作る', '② 集計する']);
});

test('静的: main.test.js の「外部への送信・ファイルの書き換えのメソッドがない」は src の全 .js を見ていて、selftest.js も入る。selftest.js は「設定」シートの名前を使わない', () => {
  const mainTest = fs.readFileSync(path.join(__dirname, 'main.test.js'), 'utf8');
  assert.match(mainTest, /fs\.readdirSync\(SRC\)\.filter\(\(n\) => n\.endsWith\('\.js'\)\)/);
  assert.ok(fs.readdirSync(SRC).includes('selftest.js'));
  const source = fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf8');
  for (const w of ['UrlFetchApp', 'MailApp', 'GmailApp', 'Utilities.newBlob', 'DriveApp.create', '.setContent(', '.setTrashed(', '.moveTo(', '.makeCopy(', "'設定'"]) {
    assert.ok(!source.includes(w), 'selftest.js に ' + w);
  }
  // SHEET_SETTINGS は指紋の一覧に名前として入るだけで、シートとしては使わない
  assert.ok(!/getSheetByName\(SHEET_SETTINGS|insertSheet\(SHEET_SETTINGS/.test(source));
});

// =====================================================================
// tester（2026-10-18）: 本番のコードや Google の返り値をわざと壊し、偽の ○ にならないかを見る
// =====================================================================
const notAllPass = (s, label) => assert.notEqual(results(s.gas)['0'].result, 'すべて合格', label);

test('壊す: 本番の toSheetText が数字で始まる文字にも \' を付けると、C01 が ×（期待値は自己テスト側の決まりで作る）', () => {
  const s = setup();
  const orig = s.ctx.toSheetText;
  s.ctx.toSheetText = (v, g) => (g && typeof v === 'string' && /^[0-9]/.test(v) ? "'" + v : orig(v, g));
  s.run();
  const r = results(s.gas);
  assert.equal(r.C01.result, '×');
  assert.match(r.C01.detail, /期待「2026-0[89]」実際「'2026-0[89]」/);
  notAllPass(s);
});

test('壊す: 本番の toSheetText が \' を付けないと、C03 が ×（本番が書く値）', () => {
  const s = setup();
  s.ctx.toSheetText = (v) => v;
  s.run();
  const r = results(s.gas);
  assert.equal(r.C03.result, '×');
  assert.match(r.C03.detail, /本番が書く値が「=SUM\(1,2\)」（期待「'=SUM\(1,2\)」）/);
  notAllPass(s);
});

test('自己テスト側の \' の決まり（selfTestGuardText_）は、本番の toSheetText と同じ結果を返す（本番の決まりを変えたら両方を直す）', () => {
  const gas = createGas({ settingsRows: null, withSelfTest: true });
  const samples = ['=1+1', '+81', '-x', '@x', '＝1+1', ' =1', "'=1", '', 'abc', '2026-10', '①', 3, null, undefined, true];
  for (const v of samples) {
    for (const g of [true, false]) assert.equal(st.selfTestGuardText_(v, g), gas.context.toSheetText(v, g), JSON.stringify(v) + ' ' + g);
  }
});

test('壊す: 書く値を 1 つずらす（明細の注文番号と商品を入れ替える・集計の金額を 1 増やす）と、C01 が × で「すべて合格」にならない', () => {
  const swap = setup();
  const detail = swap.ctx.buildDetailValues;
  swap.ctx.buildDetailValues = (d, g) => detail(d, g).map((row, i) => (i === 0 ? row : [row[0], row[1], row[3], row[2]].concat(row.slice(4))));
  swap.run();
  assert.equal(results(swap.gas).C01.result, '×');
  assert.match(results(swap.gas).C01.detail, /明細 C2: 期待「A-1001」/);
  notAllPass(swap);

  const plus = setup();
  const summary = plus.ctx.buildSummaryValues;
  plus.ctx.buildSummaryValues = function () { const v = summary.apply(null, arguments); if (typeof v[1][3] === 'number') v[1][3] += 1; return v; };
  plus.run();
  for (const id of ['C01', 'C05', 'C12', 'C13', 'C19']) assert.equal(results(plus.gas)[id].result, '×', id);
  notAllPass(plus);
});

test('壊す: 本番がエラーを無視して success を返すと、inputError の項目（C08・C09・C11・C14〜C17）がすべて ×', () => {
  const s = setup();
  const aggregate = s.ctx.aggregateWith_;
  s.ctx.aggregateWith_ = (clock, settings) => { const r = aggregate(clock, settings); return r.status === 'inputError' ? { status: 'success', message: '集計しました（モック）' } : r; };
  s.run();
  const r = results(s.gas);
  for (const id of ['C08', 'C09', 'C11', 'C14', 'C15', 'C16', 'C17']) {
    assert.equal(r[id].result, '×', id);
    assert.match(r[id].detail, /status が「success」（期待「inputError」）/, id);
  }
  notAllPass(s);
});

test('壊す: Google の getSheetId がいつも同じ値を返すと、作り直しの確認で × になり「すべて合格」にならない', () => {
  const s = setup();
  const ss = s.ctx.SpreadsheetApp.getActiveSpreadsheet();
  const proto = Object.getPrototypeOf(ss.insertSheet('tmp'));
  ss.deleteSheet(s.gas.sheet('tmp'));
  proto.getSheetId = () => 1;
  s.run();
  const r = results(s.gas);
  assert.match(r.C05.detail, /作り直されていません/);
  assert.equal(r.C05.result, '×');
  notAllPass(s);
});

test('壊す: 本番の foreignSheetMessage が空の文を返すと、C10 が ×（indexOf が 0 で素通りしない）', () => {
  const s = setup();
  s.ctx.foreignSheetMessage = () => '';
  s.run();
  const r = results(s.gas);
  assert.equal(r.C10.result, '×');
  assert.match(r.C10.detail, /文に「「明細」シートは、このツールが作ったものではないようです/);
  notAllPass(s);
});

// 監査 docs/reviews/selftest-csv-audit.md 必須 1（仕様 4.5）: 判定に本番の定数・関数を使わない
test('自己テスト側の値（4.5）は本番と同じ: SELFTEST_OUTPUT_SHEETS と OUTPUT_SHEETS、SELFTEST_DECODE_MESSAGE と DECODE_FAILURE_MESSAGE、SELFTEST_FOREIGN_MESSAGE と foreignSheetMessage(\'明細\', [])（本番を変えたら両方を直す）', () => {
  const lib = require('../src/gas-lib.js');
  assert.deepEqual(st.SELFTEST_OUTPUT_SHEETS, lib.OUTPUT_SHEETS);
  assert.equal(st.SELFTEST_DECODE_MESSAGE, lib.DECODE_FAILURE_MESSAGE);
  assert.equal(st.SELFTEST_FOREIGN_MESSAGE, lib.foreignSheetMessage('明細', []));
  // GAS と同じ読み込み方（4 つのファイルを 1 つのグローバルに読む）でも同じ
  const gas = createGas({ settingsRows: null, withSelfTest: true });
  assert.deepEqual(Array.from(gas.context.SELFTEST_OUTPUT_SHEETS), Array.from(gas.context.OUTPUT_SHEETS));
  assert.equal(gas.context.SELFTEST_DECODE_MESSAGE, gas.context.DECODE_FAILURE_MESSAGE);
  assert.equal(gas.context.SELFTEST_FOREIGN_MESSAGE, gas.context.foreignSheetMessage('明細', []));
});

test('selftest.js は判定に本番の OUTPUT_SHEETS・DECODE_FAILURE_MESSAGE・foreignSheetMessage を使わない（指紋の一覧の名前を除く）', () => {
  const src = fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf8')
    .split('\n').filter((l) => !/^  '[A-Za-z0-9_$]+',$/.test(l)).join('\n');
  for (const name of ['OUTPUT_SHEETS', 'DECODE_FAILURE_MESSAGE', 'foreignSheetMessage']) {
    const code = src.replace(/\/\/.*$|^ \*.*$/gm, '');
    assert.ok(!new RegExp('(^|[^A-Za-z0-9_$])' + name + '([^A-Za-z0-9_$]|$)').test(code), name + ' を使っています');
  }
});

test('壊す: 本番の DECODE_FAILURE_MESSAGE を空にする・別の文にすると、C08・C09 が ×（期待の文は自己テストに書いてある）', () => {
  for (const value of ['', '間違った文']) {
    const s = setup();
    s.ctx.DECODE_FAILURE_MESSAGE = value;
    s.run();
    const r = results(s.gas);
    assert.equal(r.C08.result, '×', JSON.stringify(value));
    assert.match(r.C08.detail, /エラー C2: 期待「文字コードの変換で読めない文字がありました。/);
    assert.equal(r.C09.result, '×', JSON.stringify(value));
    assert.match(r.C09.detail, /a_2026-08\.csv の内容: 期待「文字コードの変換で読めない文字がありました。/);
    notAllPass(s, JSON.stringify(value));
  }
});

test('壊す: 本番の foreignSheetMessage が「明細」だけを返すと、C10 が ×（「明細」を含むかだけでは見ない）', () => {
  const s = setup();
  s.ctx.foreignSheetMessage = (name) => '「' + name + '」';
  s.run();
  const r = results(s.gas);
  assert.equal(r.C10.result, '×');
  assert.match(r.C10.detail, /文に「「明細」シートは、このツールが作ったものではないようです/);
  notAllPass(s);
});

test('壊す: 本番の OUTPUT_SHEETS から名前が 1 つ欠けると、「すべて合格」にならない（自己テストは自分の一覧で出力のシートを見る）', () => {
  for (const drop of ['集計', '月別合計', '明細', '取り込み結果', 'エラー']) {
    const s = setup();
    s.ctx.OUTPUT_SHEETS = s.ctx.OUTPUT_SHEETS.filter((n) => n !== drop);
    s.run();
    notAllPass(s, drop);
    assert.deepEqual(Array.from(s.ctx.SELFTEST_OUTPUT_SHEETS), ['集計', '月別合計', '明細', '取り込み結果', 'エラー']);
  }
});

test('壊す: C05 の中で 01 の input のファイルが 1 つ消える（ゴミ箱に入る）と、C07 が ×（未実施で隠さない）', () => {
  const s = setup();
  wrapPlan(s.gas, 'C05', (c, orig) => { try { return orig(c); } finally { fileIn(s.tree, '01-basic/input/b_2026-09.csv').file.trashed = true; } });
  s.run();
  const r = results(s.gas);
  assert.equal(r.C07.result, '×');
  assert.match(r.C07.detail, /b_2026-09.csv が C05 のあとにありません/);
  notAllPass(s);
});

test('項目が違いを見つけたあとで実施できなくなっても、未実施ではなく ×（5 章の冒頭）', () => {
  const s = setup();
  wrapPlan(s.gas, 'C12', (c) => { c.expect(3); c.check('1 つ目', false, 'わざとの違い'); c.notRun('実施できません: わざと'); });
  s.run();
  const r = results(s.gas);
  assert.equal(r.C12.result, '×');
  assert.match(r.C12.detail, /わざとの違い。実施できません: わざと$/);
  notAllPass(s);
});

test('続き: SELFTEST_PLAN の項目が呼ぶ関数だけを差し替えても、コードの指紋が変わって最初からになる', () => {
  const s = setup();
  const adv = advanceAfter(s, 'C11');
  s.run();
  adv.off();
  s.ctx.SELFTEST_PLAN.find((p) => p.id === 'C13').run = s.ctx.selfTestC12_;
  s.clock.t += 1 * MIN;
  s.run();
  assert.match(cellOf(s.gas, 'I04', 5), /（コード: [0-9a-f]{8} → [0-9a-f]{8}）/);
  assert.equal(results(s.gas).C01.run, '1');
  assert.equal(cellOf(s.gas, 'I01', 5).split(' / ').length, 1);
});

test('続き: 前回の「自己テスト」シートの行が欠けている（結果の一部が欠ける）と、続きにせず最初から', () => {
  const s = setup();
  const adv = advanceAfter(s, 'C11');
  s.run();
  adv.off();
  const sheet = s.gas.sheet('自己テスト');
  const row = sheet.text().findIndex((r) => r[0] === 'C09') + 1;
  sheet.getRange(row, 1, 1, 7).setValues([['', '', '', '', '', '', '']]);
  s.clock.t += 1 * MIN;
  s.run();
  assert.match(cellOf(s.gas, 'I04', 5), /前回の結果の形が違うので最初から実施/);
  assert.equal(results(s.gas).C09.run, '1');
  assert.equal(results(s.gas)['0'].result, 'すべて合格');
});

test('時間切れのあとに押し直す: 2 回目も時間切れなら、組の外の項目は 3 回目に続きから。前の回の × は残り「すべて合格」にならない', () => {
  const s = setup();
  wrapPlan(s.gas, 'C09', () => { throw new Error('わざとの例外'); });
  // 関数の差し替えはコードの指紋に入るので、1 回目の前に全部済ませる（あとから差し替えると最初からになる）
  const a1 = advanceAfter(s, 'C11');
  const a2 = advanceAfter(s, 'C14');
  a2.off();
  s.run();
  a1.off();
  a2.on = true;
  s.clock.t += 1 * MIN;
  s.run();
  a2.off();
  let r = results(s.gas);
  assert.equal(r.C14.run, '2');
  assert.match(r.C15.detail, /^時間:/);
  s.clock.t += 1 * MIN;
  s.run();
  r = results(s.gas);
  assert.equal(r.C09.result, '×');
  assert.equal(r.C09.run, '1');
  assert.equal(r.C15.run, '3');
  assert.equal(r['0'].result, '不合格');
  assert.equal(cellOf(s.gas, 'I01', 5).split(' / ').length, 3);
});

test('時間切れのあとに押し直す: 自己テストの実行中（ドキュメントのロックが取れない）に押しても、シートを変えない', () => {
  const s = setup();
  const adv = advanceAfter(s, 'C11');
  s.run();
  adv.off();
  const before = s.gas.sheet('自己テスト').text();
  // 同じスプレッドシートで、前の実行がまだロックを持っているまね
  s.ctx.LockService.getDocumentLock = () => ({ tryLock: () => false, releaseLock: () => {} });
  assert.equal(s.run().status, 'locked');
  assert.deepEqual(s.gas.sheet('自己テスト').text(), before);
});
