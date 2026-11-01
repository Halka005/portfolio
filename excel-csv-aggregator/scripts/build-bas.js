/**
 * src/CsvAggregator.bas（UTF-8・LF）から、Excel に取り込む dist/CsvAggregator.bas（Shift_JIS・CRLF）を作る。
 * VBA エディターは .bas を Shift_JIS（日本語 Windows の ANSI）として読むため（docs/research/vba-csv-reading.md 項目 9）。
 * Shift_JIS にできない文字があれば、行番号を出して失敗する。
 *   node scripts/build-bas.js          … dist/ を書き換える
 *   require('./build-bas.js').build()   … テストから、書き込まずに中身だけ作る
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'CsvAggregator.bas');
const DIST = path.join(__dirname, '..', 'dist', 'CsvAggregator.bas');

let encodeTable = null;

/** Node.js の TextDecoder('shift_jis') から、文字 → バイト列の対応表を作る */
function buildEncodeTable() {
  const decoder = new TextDecoder('shift_jis', { fatal: false });
  const table = new Map();
  const put = (bytes) => {
    const ch = decoder.decode(Uint8Array.from(bytes));
    if (ch.length === 0 || ch.includes('�') || [...ch].length !== 1) return;
    if (!table.has(ch)) table.set(ch, bytes);
  };
  for (let b = 0x00; b <= 0x7f; b++) put([b]);
  for (let b = 0xa1; b <= 0xdf; b++) put([b]);
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead >= 0xa0 && lead <= 0xdf) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      put([lead, trail]);
    }
  }
  return table;
}

/** 文字列を Shift_JIS のバイト列にする。変換できない文字は { line, char } の一覧で返す */
function encodeShiftJis(text) {
  if (!encodeTable) encodeTable = buildEncodeTable();
  const out = [];
  const bad = [];
  let line = 1;
  for (const ch of text) {
    if (ch === '\n') line++;
    const bytes = encodeTable.get(ch);
    if (!bytes) { bad.push({ line, char: ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') }); continue; }
    out.push(...bytes);
  }
  return { bytes: Buffer.from(out), bad };
}

/** src の中身から dist の中身（Buffer）を作る */
function build(srcText) {
  const text = (srcText === undefined ? fs.readFileSync(SRC, 'utf8') : srcText).replace(/\r\n/g, '\n');
  const crlf = text.replace(/\n/g, '\r\n');
  const { bytes, bad } = encodeShiftJis(crlf);
  if (bad.length > 0) {
    const list = bad.map((b) => `  ${b.line} 行目: 「${b.char}」(${b.code})`).join('\n');
    throw new Error('Shift_JIS にできない文字があります。ChrW などに置き換えてください:\n' + list);
  }
  // 往復の確認: Shift_JIS から戻して、元と同じ文字列になること
  const back = new TextDecoder('shift_jis').decode(bytes);
  if (back !== crlf) throw new Error('Shift_JIS に変換して戻すと、元の文字列と一致しません');
  return bytes;
}

if (require.main === module) {
  const bytes = build();
  fs.mkdirSync(path.dirname(DIST), { recursive: true });
  fs.writeFileSync(DIST, bytes);
  console.log(`dist/CsvAggregator.bas を作りました（${bytes.length} バイト、Shift_JIS・CRLF）`);
}

module.exports = { build, encodeShiftJis, SRC, DIST };
