/**
 * GAS のサービスの偽物（モック）。tests/main.test.js と tests/cases.test.js で使う。
 * 本物の困る動きをまねる（仕様 8.2）:
 * - Blob.getBytes() は −128〜127 の数の普通の配列を返す（Java の byte と同じ符号つき）
 * - getDataAsString('Shift_JIS') は Java の SJIS.map をまね、表にない 2 バイト文字（1 バイト目が 0x87・0xED・0xEE・0xFA・0xFB・0xFC）を U+FFFD にする。
 *   2 バイトの組で進み、組の 1 バイト目だけで判定する（「方」0x95 0xFB の 2 バイト目を誤って当てないため）
 * - getDataAsString は getBlob() で返した Blob にだけある。文字コード名は 4 つだけ受け付ける
 * - getRange はシートの大きさ（新しいシートは 1,000 行 × 26 列）を超えると例外
 * - Utilities.newBlob は呼ばれたら例外（src で使わないことの確認）
 * 限界: GAS が本当に Java の表を使うか、U+FFFD にするか（? にするか）は、モックでは分からない（README の動作確認で確かめる）。
 *
 * 自己テスト（src/selftest.js。docs/specs/selftest.md 9.1）のために足したもの。どれも本物の「まね」で、本物の動きは README の自己テストで確かめる:
 * - ドライブのフォルダの木（driveTree）。ID でどのフォルダも引ける getFolderById、ゴミ箱のフォルダも返す getFoldersByName、File.getSize・getLastUpdated
 * - Sheet.getSheetId（シートを作るたびに新しい番号。setName では変わらない）、getDataRange
 * - 数式のまね: 値が = で始まる文字で、書式が @ でなければ数式とみなす。setFormula でも入る。
 *   計算するのは =ISFORMULA(参照)・=LEN(参照)・=シート!セル の 3 つの形だけ（ほかは '#MOCK!'）。
 *   シートの参照は setFormula のときのシートに結び付け、そのシートが消えたら #REF!（本物の動きの見込み。未確認）
 * - getFormulas・getNumberFormats・getDisplayValue・getValue、setFontColors・setBackgrounds・setWrap、Spreadsheet.getName、LockService.getDocumentLock
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const FOLDER_ID = 'TestFolder0001';
const SELF_ID = 'SpreadsheetSelf01';
const FOLDER_URL = 'https://drive.google.com/drive/folders/' + FOLDER_ID;
const CHARSETS = ['Shift_JIS', 'windows-31j', 'MS932', 'UTF-8'];
const JAVA_SJIS_MISSING_LEADS = [0x87, 0xed, 0xee, 0xfa, 0xfb, 0xfc];

/** Java の Shift_JIS（SJIS.map）をまねた変換。表にない 2 バイト文字は U+FFFD */
function decodeJavaShiftJis(bytes) {
  const decoder = new TextDecoder('shift_jis');
  let out = '';
  let run = [];
  const flush = () => { if (run.length) { out += decoder.decode(new Uint8Array(run)); run = []; } };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const isLead = (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
    if (isLead && i + 1 < bytes.length) {
      if (JAVA_SJIS_MISSING_LEADS.includes(b)) { flush(); out += '�'; } else run.push(b, bytes[i + 1]);
      i++;
    } else {
      run.push(b);
    }
  }
  flush();
  return out;
}

function decodeAs(charset, bytes) {
  if (charset === 'Shift_JIS') return decodeJavaShiftJis(bytes);
  if (charset === 'windows-31j' || charset === 'MS932') return new TextDecoder('shift_jis', { ignoreBOM: true }).decode(bytes);
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

const iterator = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };

/**
 * options:
 *   files: [{ name, bytes, mimeType?, id?, trashed?, getBlobThrows? }]、folders: [{ name, files, trashed? }]
 *   settingsRows: 「設定」の 2 行目以降（null なら「設定」シートなし）
 *   sheets: { 名前: 行の配列 }（前回の出力など）
 *   lock: false ならロックを取れない。関数なら (何回目か) => 取れるか
 *   docLock: false なら getDocumentLock を取れない
 *   name: スプレッドシートの名前（getName）
 *   driveTree: [{ name, id?, trashed?, files: [{ name, bytes, mimeType?, trashed?, lastUpdated? }], folders: [同じ形] }]（ID で引けるフォルダ）
 *   withSelfTest: true なら src/selftest.js も読む
 *   fail: { setValuesAt: n, flush: true, deleteSheetAt: n }
 *   onGetBytes: (name) => void（時間を進めるなど）
 */
function createGas(options = {}) {
  const calls = { events: [], getBytes: [], getBlob: [], charsets: [], flush: 0, alerts: [], logs: [], errors: [], forbidden: [], setValues: 0, deleteSheet: 0, scriptLocks: 0 };
  const fail = options.fail || {};
  const event = (e) => calls.events.push(e);

  // ---- Spreadsheet ----
  const sheets = [];
  let active = null;
  let sheetIdCounter = 0;
  const colNumber = (letters) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  // =ISFORMULA(参照)・=LEN(参照)・=シート!セル だけを計算する（数式のまね）
  const evaluateFormula = (sheet, f) => {
    const m = /^=(ISFORMULA|LEN)?\(?(?:(.+)!)?([A-Z]+)(\d+)\)?$/.exec(f.text);
    if (!m) return '#MOCK!';
    let target = f.refSheet === undefined ? (m[2] ? sheets.find((s) => s.name === m[2]) : sheet) : f.refSheet;
    if (!target || !sheets.includes(target)) return '#REF!';
    const r = Number(m[4]);
    const c = colNumber(m[3]);
    if (m[1] === 'ISFORMULA') return target.formulaAt(r, c) !== '';
    const v = target.value(r, c);
    if (m[1] === 'LEN') return String(v).length;
    return v;
  };
  class Range {
    constructor(sheet, r, c, nr, nc) {
      if (!(r >= 1 && c >= 1 && nr >= 1 && nc >= 1) || r + nr - 1 > sheet.maxRows || c + nc - 1 > sheet.maxCols) {
        throw new Error('範囲がシートの外です: ' + sheet.name + ' (' + [r, c, nr, nc].join(',') + ') 大きさ ' + sheet.maxRows + '×' + sheet.maxCols);
      }
      Object.assign(this, { sheet, r, c, nr, nc });
    }
    each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); return this; }
    getValues() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sheet.value(this.r + i, this.c + j))); }
    getValue() { return this.sheet.value(this.r, this.c); }
    getDisplayValue() { return String(this.getValue()); }
    getDisplayValues() { return this.getValues().map((row) => row.map(String)); }
    getFormulas() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sheet.formulaAt(this.r + i, this.c + j))); }
    getFormula() { return this.sheet.formulaAt(this.r, this.c); }
    getNumberFormats() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sheet.format[(this.r + i) + ',' + (this.c + j)] || 'General')); }
    setFormula(f) {
      const m = /^=(?:ISFORMULA\(|LEN\()?(?:(.+)!)?[A-Z]+\d+\)?$/.exec(f);
      const refSheet = m && m[1] ? spreadsheet.getSheetByName(m[1]) : this.sheet;
      this.sheet.formulas[this.r + ',' + this.c] = { text: f, refSheet };
      this.sheet.cells[this.r + ',' + this.c] = f;
      return this;
    }
    setFontColor(color) { return this.each((r, c) => { this.sheet.fontColor[r + ',' + c] = color; }); }
    setFontColors(colors) { return this.each((r, c, i, j) => { this.sheet.fontColor[r + ',' + c] = colors[i][j]; }); }
    setBackgrounds(colors) { return this.each((r, c, i, j) => { this.sheet.background[r + ',' + c] = colors[i][j]; }); }
    setWrap(w) { return this.each((r, c) => { this.sheet.wrap[r + ',' + c] = w; }); }
    setValues(values) {
      calls.setValues++;
      if (fail.setValuesAt && calls.setValues === fail.setValuesAt) throw new Error('setValues に失敗しました（モック）');
      if (values.length !== this.nr || values.some((row) => row.length !== this.nc)) throw new Error('値の大きさが範囲と違います');
      event({ op: 'setValues', sheet: this.sheet.name, r: this.r, c: this.c, nr: this.nr, nc: this.nc });
      return this.each((r, c, i, j) => { delete this.sheet.formulas[r + ',' + c]; this.sheet.set(r, c, values[i][j]); });
    }
    setValue(v) { return this.setValues([[v]]); }
    setNumberFormat(fmt) {
      event({ op: 'setNumberFormat', sheet: this.sheet.name, r: this.r, c: this.c, nr: this.nr, nc: this.nc, fmt });
      return this.each((r, c) => { this.sheet.format[r + ',' + c] = fmt; });
    }
    setBackground(color) { return this.each((r, c) => { this.sheet.background[r + ',' + c] = color; }); }
    setFontWeight(w) { return this.each((r, c) => { this.sheet.weight[r + ',' + c] = w; }); }
    setDataValidation(rule) { return this.each((r, c) => { this.sheet.validation[r + ',' + c] = rule; }); }
  }
  class Sheet {
    constructor(name, rows) {
      sheetIdCounter += 1;
      Object.assign(this, { name, id: 1000 + sheetIdCounter, maxRows: 1000, maxCols: 26, cells: {}, format: {}, background: {}, weight: {}, validation: {}, frozen: 0, widths: {}, formulas: {}, fontColor: {}, wrap: {} });
      (rows || []).forEach((row, i) => row.forEach((v, j) => this.set(i + 1, j + 1, v)));
    }
    get(r, c) { const v = this.cells[r + ',' + c]; return v === undefined ? '' : v; }
    set(r, c, v) { if (v === '' || v === undefined || v === null) delete this.cells[r + ',' + c]; else this.cells[r + ',' + c] = v; }
    getName() { return this.name; }
    getSheetId() { return this.id; }
    getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    /** 数式のまねの判定（このファイルの先頭のコメント） */
    formulaAt(r, c) {
      const k = r + ',' + c;
      if (this.formulas[k]) return this.formulas[k].text;
      const v = this.get(r, c);
      return typeof v === 'string' && v.charAt(0) === '=' && this.format[k] !== '@' ? v : '';
    }
    /** getValues が返す値。数式なら計算のまねをする */
    value(r, c) {
      const k = r + ',' + c;
      const f = this.formulas[k] || (this.formulaAt(r, c) ? { text: this.get(r, c), refSheet: undefined } : null);
      return f ? evaluateFormula(this, f) : this.get(r, c);
    }
    setName(n) {
      if (sheets.some((s) => s !== this && s.name === n)) throw new Error('同じ名前のシートがあります: ' + n);
      event({ op: 'setName', sheet: this.name, to: n });
      this.name = n;
      return this;
    }
    getIndex() { return sheets.indexOf(this) + 1; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    insertRowsAfter(after, n) { if (after > this.maxRows) throw new Error('行の位置が外です'); this.maxRows += n; return this; }
    insertColumnsAfter(after, n) { if (after > this.maxCols) throw new Error('列の位置が外です'); this.maxCols += n; return this; }
    deleteColumns(start, n) {
      if (start < 1 || start + n - 1 > this.maxCols) throw new Error('列の位置が外です');
      if (n >= this.maxCols) throw new Error('すべての列は消せません');
      this.maxCols -= n;
      return this;
    }
    getLastRow() { return Math.max(0, ...Object.keys(this.cells).map((k) => Number(k.split(',')[0]))); }
    getLastColumn() { return Math.max(0, ...Object.keys(this.cells).map((k) => Number(k.split(',')[1]))); }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    setFrozenRows(n) { this.frozen = n; return this; }
    getFrozenRows() { return this.frozen; }
    setColumnWidth(c, w) { this.widths[c] = w; return this; }
    autoResizeColumns(start, n) { new Range(this, 1, start, 1, n); return this; }
    activate() { active = this; return this; }
    /** テスト用: 値を文字にした 2 次元配列（1 行目から最後の行・列まで） */
    text() {
      const rows = this.getLastRow();
      const cols = this.getLastColumn();
      return Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => String(this.get(i + 1, j + 1))));
    }
    /** テスト用: text() のうち、最初の空の行より前（表の部分）。「エラー」の表の下の実行日時などを除いて比べるため */
    table() {
      const rows = this.text();
      const blank = rows.findIndex((r) => r.every((v) => v === ''));
      return blank === -1 ? rows : rows.slice(0, blank);
    }
  }
  if (options.settingsRows !== null) {
    sheets.push(new Sheet('設定', [['キー', '値', '説明']].concat(options.settingsRows || [])));
  }
  Object.entries(options.sheets || {}).forEach(([name, rows]) => sheets.push(new Sheet(name, rows)));
  const spreadsheet = {
    getId: () => SELF_ID,
    getName: () => (options.name === undefined ? 'テスト用' : options.name),
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    getSheets: () => sheets.slice(),
    insertSheet: (name, index) => {
      if (sheets.some((s) => s.name === name)) throw new Error('同じ名前のシートがあります: ' + name);
      const sheet = new Sheet(name);
      sheets.splice(index === undefined ? sheets.length : index, 0, sheet);
      event({ op: 'insertSheet', sheet: name });
      active = sheet;
      return sheet;
    },
    deleteSheet: (sheet) => {
      calls.deleteSheet++;
      if (fail.deleteSheetAt && calls.deleteSheet === fail.deleteSheetAt) throw new Error('シートを消せませんでした（モック）');
      const i = sheets.indexOf(sheet);
      if (i === -1) throw new Error('シートがありません');
      sheets.splice(i, 1);
      event({ op: 'deleteSheet', sheet: sheet.name });
    },
    getActiveSheet: () => active,
  };

  // ---- Drive ----
  const makeFile = (spec) => {
    if (!spec.lastUpdated) spec.lastUpdated = new Date(Date.UTC(2026, 9, 1, 0, 0, 0));
    const file = {
      getName: () => spec.name,
      getSize: () => (spec.bytes ? spec.bytes.length : 0),
      getLastUpdated: () => new Date(spec.lastUpdated.getTime()),
      getId: () => spec.id || 'file-' + spec.name,
      getMimeType: () => spec.mimeType || (spec.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/plain'),
      isTrashed: () => !!spec.trashed,
      getBlob: () => {
        calls.getBlob.push(spec.name);
        if (spec.getBlobThrows) throw new Error(spec.getBlobThrows);
        return {
          getBytes: () => {
            calls.getBytes.push(spec.name);
            if (options.onGetBytes) options.onGetBytes(spec.name);
            return Array.from(new Int8Array(Uint8Array.from(spec.bytes).buffer));
          },
          getDataAsString: (charset) => {
            if (!CHARSETS.includes(charset)) throw new Error('Unsupported charset: ' + charset);
            calls.charsets.push([spec.name, charset]);
            return decodeAs(charset, Uint8Array.from(spec.bytes));
          },
        };
      },
    };
    for (const m of ['setContent', 'setTrashed', 'moveTo', 'makeCopy', 'setName', 'setDescription']) {
      file[m] = () => { calls.forbidden.push(spec.name + '.' + m); return file; };
    }
    return file;
  };
  const makeFolder = (name, files, folders, trashed) => ({
    getName: () => name,
    getId: () => FOLDER_ID,
    isTrashed: () => !!trashed,
    getFiles: () => iterator((files || []).map(makeFile)),
    getFolders: () => iterator((folders || []).map((f) => makeFolder(f.name, f.files, [], f.trashed))),
  });
  const root = makeFolder(options.folderName || 'input', options.files, options.folders, false);

  // driveTree: ID で引けるフォルダの木（自己テスト用）。spec を後から書き換えると、次に読んだときに変わる
  const treeById = new Map();
  let treeCounter = 0;
  const makeTreeFolder = (spec) => {
    if (!spec.id) { treeCounter += 1; spec.id = 'TreeFolder' + String(treeCounter).padStart(4, '0'); }
    const folder = {
      getName: () => spec.name,
      getId: () => spec.id,
      isTrashed: () => !!spec.trashed,
      getFiles: () => iterator((spec.files || []).map(makeFile)),
      getFolders: () => iterator((spec.folders || []).map(makeTreeFolder)),
    };
    treeById.set(spec.id, folder);
    return folder;
  };
  const allTreeFolders = () => {
    const out = [];
    const walk = (list) => (list || []).forEach((spec) => { out.push(makeTreeFolder(spec)); walk(spec.folders); });
    walk(options.driveTree);
    return out;
  };
  allTreeFolders();

  const context = vm.createContext({
    console: { log: (...a) => calls.logs.push(a.join(' ')), error: (...a) => calls.errors.push(a.join(' ')) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getUi: () => ({
        alert: (m) => calls.alerts.push(m),
        createMenu: (title) => {
          const menu = { title, items: [], addItem: (label, fn) => { menu.items.push([label, fn]); return menu; }, addSeparator: () => menu, addToUi: () => { calls.menu = menu; } };
          return menu;
        },
      }),
      flush: () => {
        calls.flush++;
        event({ op: 'flush' });
        if (fail.flush) throw new Error('flush に失敗しました（モック）');
      },
      newDataValidation: () => {
        const rule = { list: null };
        const builder = { requireValueInList: (list, show) => { rule.list = Array.from(list); rule.show = show; return builder; }, build: () => rule };
        return builder;
      },
    },
    DriveApp: {
      getFolderById: (id) => {
        if (id === FOLDER_ID) return root;
        allTreeFolders();
        if (treeById.has(id)) return treeById.get(id);
        throw new Error('Exception: No item with the given ID could be found. (モック)');
      },
      getFoldersByName: (name) => {
        if (options.getFoldersByNameThrows) throw new Error('getFoldersByName に失敗しました（モック）');
        return iterator(allTreeFolders().filter((f) => f.getName() === name));
      },
    },
    Utilities: {
      formatDate: (date, tz, fmt) => {
        if (tz !== 'Asia/Tokyo' || (fmt !== 'yyyy-MM-dd HH:mm:ss' && fmt !== 'yyyy-MM-dd HH:mm')) throw new Error('モックが対応していない書式です');
        const d = new Date(date.getTime() + 9 * 3600 * 1000);
        const p = (n) => String(n).padStart(2, '0');
        const minutes = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
        return fmt === 'yyyy-MM-dd HH:mm' ? minutes : minutes + ':' + p(d.getUTCSeconds());
      },
      newBlob: () => { throw new Error('Utilities.newBlob は使わない設計です（モック）'); },
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { calls.scriptLocks += 1; return typeof options.lock === 'function' ? options.lock(calls.scriptLocks) : options.lock !== false; },
        releaseLock: () => { calls.released = true; },
      }),
      getDocumentLock: () => ({ tryLock: () => options.docLock !== false, releaseLock: () => { calls.docReleased = true; } }),
    },
  });
  for (const f of ['lib.js', 'gas-lib.js', 'main.js'].concat(options.withSelfTest ? ['selftest.js'] : [])) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
  }

  const plain = (x) => JSON.parse(JSON.stringify(x));
  return {
    context,
    calls,
    sheets,
    sheet: (n) => sheets.find((s) => s.name === n) || null,
    sheetNames: () => sheets.map((s) => s.name),
    run: (clock) => plain(context.aggregateFolder(clock)),
    selfTest: (clock) => context.selfTest_(clock),
  };
}

const CASES_DIR = path.join(__dirname, '..', '..', 'excel-csv-aggregator', 'tests', 'cases');

/**
 * リポジトリの excel-csv-aggregator/tests/cases から、ドライブの「cases」フォルダの木（driveTree の 1 つ分）を作る。
 * mutate(tree) で書き換えてから渡せる（ファイルを消す・大きさを変えるなど）
 */
function casesTree(mutate) {
  const filesOf = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort()
    .map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) })) : []);
  const tree = {
    name: 'cases',
    id: 'CasesFolder0001',
    files: [],
    folders: fs.readdirSync(CASES_DIR).sort().map((c) => ({
      name: c,
      files: filesOf(path.join(CASES_DIR, c)),
      folders: ['expected', 'input'].map((sub) => ({ name: sub, files: filesOf(path.join(CASES_DIR, c, sub)) })),
    })),
  };
  if (mutate) mutate(tree);
  return tree;
}

/** casesTree の中のフォルダ（例: '01-basic/input'）を探す */
function treeFolder(tree, p) {
  return p.split('/').reduce((f, name) => (f ? (f.folders || []).find((x) => x.name === name) : null), tree);
}

/** 「設定」の行（2 行目以降）を作る */
function settingsRows(overrides = {}) {
  const base = {
    CSV_FOLDER: FOLDER_URL, ENCODING: '自動', COL_DATE: '注文日', COL_PRODUCT: '商品名', COL_QUANTITY: '数量',
    COL_AMOUNT: '金額', COL_ORDER_ID: '注文番号', DEDUPE: true, QUOTE_CHECK: true,
  };
  return Object.entries(Object.assign(base, overrides)).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v, '']);
}

/** フォルダのファイルを読んで createGas の files にする */
function filesFromDir(dir) {
  return fs.readdirSync(dir).sort().map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
}

module.exports = { createGas, settingsRows, filesFromDir, decodeJavaShiftJis, casesTree, treeFolder, CASES_DIR, FOLDER_ID, FOLDER_URL, SELF_ID };
