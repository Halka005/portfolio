/**
 * VBA ソース（src/CsvAggregator.bas）の静的チェック。
 * この環境では VBA を実行できないため、実行しなくても分かる間違いだけをここで止める。
 * VBA が正しく動くことの確認にはならない（README の「9. 動作確認」を参照）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { build, SRC, DIST } = require('../scripts/build-bas.js');
const lib = require('../src/lib.js');

const source = fs.readFileSync(SRC, 'utf8');
const lines = source.split('\n');
/** コメントと文字列を除いたコード部分 */
const code = lines.map((l) => {
  let out = '';
  let inStr = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (!inStr && c === "'") break;
    out += inStr ? ' ' : c;
  }
  return out;
});

// 参照実装と同じ名前で VBA にある関数（docs/specs/excel-csv-aggregator.md の 4）
const SHARED = ['IsValidUtf8', 'HasUtf16Bom', 'DetectEncoding', 'StripBom', 'ParseCsv', 'CleanFolderPath', 'TrimText', 'ParseNumber', 'ParseDate',
  'FindColumns', 'NormalizeRows', 'DedupeRecords', 'AggregateByMonthProduct', 'AggregateByMonth', 'ListCsvFiles',
  'QuoteTailMessage', 'QuoteCommaMessage'];

test('取り込みに必要な先頭行と Option Explicit がある', () => {
  assert.equal(lines[0], 'Attribute VB_Name = "CsvAggregator"');
  assert.ok(code.some((l) => /^Option Explicit\s*$/.test(l)));
});

test('参照実装と同じ名前の関数が、VBA と lib.js の両方にある', () => {
  for (const name of SHARED) {
    assert.ok(new RegExp(`^Private (Function|Sub) ${name}\\(`, 'm').test(source), `VBA に ${name} がない`);
    assert.equal(typeof lib[name], 'function', `lib.js に ${name} がない`);
  }
});

test('エラーの文言（閉じていない引用符・UTF-16・迷子の引用符の判定 A・B）が VBA と lib.js で同じ', () => {
  for (const name of ['UNCLOSED_QUOTE_MESSAGE', 'UTF16_MESSAGE', 'QUOTE_TAIL_MESSAGE', 'QUOTE_COMMA_MESSAGE']) {
    const m = source.match(new RegExp(`^Private Const ${name} As String = "(.*)"\\s*$`, 'm'));
    assert.ok(m, `VBA に ${name} がない`);
    assert.equal(m[1].replace(/""/g, '"'), lib[name], name);
  }
});

test('ParseCsv: 引用符の中の改行は vbLf にそろえる（vbCrLf や ch をそのまま足さない）', () => {
  const body = source.slice(source.indexOf('Private Function ParseCsv('), source.indexOf('End Function', source.indexOf('Private Function ParseCsv(')));
  assert.ok(/field = field & vbLf\b/.test(body));
  assert.ok(!/field = field & vbCrLf/.test(body));
});

test('マクロの一覧に出す Public の手続きは SetupSettings と RunAggregation だけ', () => {
  const publics = code.map((l) => l.match(/^Public (?:Sub|Function) (\w+)/)).filter(Boolean).map((m) => m[1]);
  assert.deepEqual(publics.sort(), ['RunAggregation', 'SetupSettings']);
  const unscoped = code.filter((l) => /^(Sub|Function) /.test(l));
  assert.deepEqual(unscoped, [], 'Public / Private のない手続きがある');
});

test('元の CSV を変えうる呼び出しがない（読むだけ）', () => {
  const banned = [/\bKill\b/, /SaveToFile/i, /Workbooks\.Open/i, /OpenText/i, /\.SaveAs\b/i, /\.Save\b/i, /Line Input/i,
    /For (Output|Append|Binary)/i, /DeleteFile|DeleteFolder|MoveFile|CopyFile|CreateTextFile|OpenTextFile/i, /\bName\s+\S+\s+As\b/];
  code.forEach((l, i) => {
    for (const re of banned) assert.ok(!re.test(l), `${i + 1} 行目: ${l.trim()}`);
  });
});

test('16 進数 &H8000 以上の定数には & を付けている（付けないと負の Integer になる）', () => {
  code.forEach((l, i) => {
    const bad = l.match(/&H[89A-F][0-9A-F]{3}(?![0-9A-F&])/gi);
    assert.equal(bad, null, `${i + 1} 行目: ${l.trim()}`);
  });
});

test('1 行は 1023 文字以内、行継続（ _）は 1 つの文で 24 回以内', () => {
  let continued = 0;
  lines.forEach((l, i) => {
    assert.ok(l.length <= 1023, `${i + 1} 行目が長すぎる`);
    if (/ _\s*$/.test(code[i])) {
      continued++;
      assert.ok(continued <= 24, `${i + 1} 行目: 行継続が多すぎる`);
    } else continued = 0;
  });
});

test('ブロックの開始と終了の数がそろっている（If / For / Do / With / Select / Sub / Function）', () => {
  const count = (re) => code.filter((l) => re.test(l.trim())).length;
  // 1 行の If（Then のあとに文があるもの）は End If を持たない
  const blockIf = code.filter((l) => /^(Else)?If\b.*\bThen\s*$/.test(l.trim()) && !/^ElseIf/.test(l.trim())).length;
  assert.equal(blockIf, count(/^End If\b/), 'If');
  assert.equal(count(/^For\b/), count(/^Next\b/), 'For');
  assert.equal(count(/^Do\b/), count(/^Loop\b/), 'Do');
  assert.equal(count(/^With\b/), count(/^End With\b/), 'With');
  assert.equal(count(/^Select Case\b/), count(/^End Select\b/), 'Select');
  assert.equal(count(/^(Public |Private )?Sub\b/), count(/^End Sub\b/), 'Sub');
  assert.equal(count(/^(Public |Private )?Function\b/), count(/^End Function\b/), 'Function');
});

test('For Each の変数は Variant か Object 型で宣言している（String などはコンパイルエラー）', () => {
  // 手続きごとに区切って調べる
  let decl = {};
  code.forEach((l, i) => {
    const t = l.trim();
    if (/^(Public |Private )?(Sub|Function) /.test(t)) {
      decl = {};
      const params = t.slice(t.indexOf('(') + 1);
      for (const m of params.matchAll(/(?:ByVal |ByRef )?(\w+)(\(\))? As (\w+)/g)) decl[m[1].toLowerCase()] = m[3];
    }
    for (const m of t.matchAll(/^Dim (\w+)(?:\([^)]*\))? As (\w+)/g)) decl[m[1].toLowerCase()] = m[2];
    const fe = t.match(/^For Each (\w+) In/);
    if (fe) {
      const type = decl[fe[1].toLowerCase()];
      assert.ok(type, `${i + 1} 行目: ${fe[1]} が宣言されていない`);
      assert.ok(!['String', 'Long', 'Integer', 'Double', 'Boolean', 'Date', 'Currency', 'Byte'].includes(type),
        `${i + 1} 行目: For Each の変数 ${fe[1]} が ${type} 型`);
    }
  });
});

test('dist/CsvAggregator.bas は src から作った Shift_JIS・CRLF 版と一致する（npm run build の実行漏れを防ぐ）', () => {
  const expected = build();
  const actual = fs.readFileSync(DIST);
  assert.ok(actual.equals(expected), 'dist が古い。npm run build を実行してください');
  assert.ok(!/(^|[^\r])\n/.test(actual.toString('latin1')), 'LF だけの改行がある');
  assert.equal(new TextDecoder('shift_jis').decode(actual).replace(/\r\n/g, '\n'), source.replace(/\r\n/g, '\n'));
});

test('build: Shift_JIS にできない文字があれば行番号つきで失敗する', () => {
  assert.throws(() => build('Attribute VB_Name = "X"\n\' 絵文字 😀\n'), /2 行目/);
  assert.throws(() => build('x = "¥"\n'), /U\+00A5/); // 半角の円記号は Shift_JIS では 0x5C（\）と区別できない
});

// ---------- 2 回目の audit の修正が VBA 側にもあること（tester 追加。実行の確認ではない） ----------
const bodyOf = (header) => {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} がない`);
  const end = source.indexOf(/^Private Sub|^Public Sub/.test(header) ? 'End Sub' : 'End Function', start);
  return source.slice(start, end);
};

test('VBA の NormalizeRows: 最後のレコードの閉じていない引用符を、見出しを探す前にエラーにしている', () => {
  const body = bodyOf('Private Sub NormalizeRows(');
  const unclosed = body.indexOf('UNCLOSED_QUOTE_MESSAGE');
  assert.ok(unclosed >= 0, 'UNCLOSED_QUOTE_MESSAGE を使っていない');
  assert.ok(/records\(records\.Count\)/.test(body), '最後のレコードを見ていない');
  assert.ok(unclosed < body.indexOf('For Each rec In records'), '見出しを探すループより後でエラーにしている');
});

test('VBA の ParseCsv: 途中のレコードは 3 つめを 0、最後のレコードは閉じていない引用符の行を入れる（4 つめから 6 つめは判定 A）', () => {
  const body = bodyOf('Private Function ParseCsv(');
  assert.ok(/records\.Add Array\(startLine, CollectionToArray\(fields\), 0, tailStartLine, tailEndLine, tailField\)/.test(body));
  assert.ok(/If inQuotes Then unclosedLine = quoteLine/.test(body));
  assert.ok(/records\.Add Array\(startLine, CollectionToArray\(fields\), unclosedLine, tailStartLine, tailEndLine, tailField\)/.test(body));
  assert.ok(/quoteLine = lineNo/.test(body), '引用符が始まった物理的な行を記録していない');
});

test('VBA の RunAggregation: CSV_FOLDER を CleanFolderPath に通し、UTF-16 の判定は ENCODING の分岐より前、データ 0 行の判定はエラーの判定より後', () => {
  const body = bodyOf('Public Sub RunAggregation(');
  assert.ok(/CleanFolderPath\(settings\("CSV_FOLDER"\)\)/.test(body));
  const utf16 = body.indexOf('HasUtf16Bom(bytes)');
  assert.ok(utf16 >= 0 && utf16 < body.indexOf('settings("ENCODING")'), 'UTF-16 の判定が ENCODING の分岐より後');
  const errorsCheck = body.indexOf('If errors.Count > 0 Then');
  const noData = body.indexOf('If details.Count = 0 Then');
  assert.ok(errorsCheck >= 0 && noData > errorsCheck, 'データ 0 行の判定がエラーの判定より前');
  // データ 0 行のときは新しいブックを作らない（判定から Exit Sub までに Workbooks.Add がない）
  const exitAfterNoData = body.indexOf('Exit Sub', noData);
  assert.ok(!body.slice(noData, exitAfterNoData).includes('Workbooks.Add'));
});

// ---------- 5.5 迷子の引用符が VBA 側にもあること（実行の確認ではない） ----------
test('VBA の ParseCsv: 判定 A。改行を読んだ引用符が閉じたとき、後ろを IsQuoteEnd で調べて最初の 1 つだけ記録し、レコードごとに戻す', () => {
  const body = bodyOf('Private Function ParseCsv(');
  assert.ok(/quoteHasNewline = True/.test(body), '引用符の中の改行を記録していない');
  assert.ok(/quoteHasNewline = False/.test(body), '引用符が始まるときに戻していない');
  assert.ok(/If quoteHasNewline And tailField < 0 Then\s+If Not IsQuoteEnd\(text, i \+ 1\) Then\s+tailStartLine = quoteLine\s+tailEndLine = lineNo\s+tailField = fields\.Count/.test(body));
  assert.ok(/tailStartLine = 0\s+tailEndLine = 0\s+tailField = -1/.test(body), 'レコードごとに戻していない');
  const end = bodyOf('Private Function IsQuoteEnd(');
  assert.ok(/IsSpaceChar\(Mid\$\(text, j, 1\)\)/.test(end), '空白を読み飛ばしていない');
  assert.ok(/IsQuoteEnd = \(c = "," Or c = vbCr Or c = vbLf\)/.test(end));
});

test('VBA の文を組み立てる関数: 定数の {…} をすべて Replace し、列名は最後に置き換える', () => {
  for (const [fn, keys] of [['QuoteTailMessage', ['startLine', 'endLine', 'column']], ['QuoteCommaMessage', ['startLine', 'endLine', 'newlines', 'commas', 'column']]]) {
    const body = bodyOf(`Private Function ${fn}(`);
    const positions = keys.map((k) => body.indexOf(`"{${k}}"`));
    positions.forEach((pos, i) => assert.ok(pos >= 0, `${fn} が {${keys[i]}} を置き換えていない`));
    assert.equal(Math.max(...positions), positions[positions.length - 1], `${fn} で列名が最後でない`);
    // lib.js の定数にある {…} と同じ組
    const libConst = fn === 'QuoteTailMessage' ? lib.QUOTE_TAIL_MESSAGE : lib.QUOTE_COMMA_MESSAGE;
    assert.deepEqual([...new Set(libConst.match(/\{\w+\}/g))].sort(), keys.map((k) => `{${k}}`).sort());
  }
  const col = bodyOf('Private Function QuoteColumnName(');
  assert.ok(/CStr\(field \+ 1\) & " 列目"/.test(col), '列の番号を 1 から数えていない');
  // 見出しの値の最初の改行より前を TrimText する（audit 3 回目 必須 1。見出しの値に後ろの行が吸い込まれていることがあるため）
  assert.ok(/cellText = CStr\(headerFields\(LBound\(headerFields\) \+ field\)\)\s+pos = InStr\(cellText, vbLf\)\s+If pos > 0 Then cellText = Left\$\(cellText, pos - 1\)\s+name = TrimText\(cellText\)/.test(col));
});

test('VBA の NormalizeRows: 判定の順番（閉じていない引用符 → 判定 A → 判定 B）と、当たったレコードで日付などを調べないこと', () => {
  const body = bodyOf('Private Sub NormalizeRows(');
  assert.ok(/^Private Sub NormalizeRows\(ByVal fileName As String, records As Collection, colNames As Object, ByVal quoteCheck As Boolean,/m.test(source));
  const unclosed = body.indexOf('quoteError = (rec(2) > 0)');
  // 見出しの分岐にも同じ式があるので、データのレコードの分岐（閉じていない引用符の判定）から後ろを探す
  const tail = body.indexOf('QuoteTailMessage(rec(3), rec(4), QuoteColumnName(headerFields, rec(5)))', unclosed);
  const comma = body.indexOf('If Not quoteError And quoteCheck Then quoteError = CheckQuoteCommas(fileName, rec, headerFields, errors)');
  const guard = body.indexOf('If Not quoteError Then');
  const date = body.indexOf('ParseDate(');
  assert.ok(unclosed >= 0 && tail > unclosed && comma > tail && guard > comma && date > guard, '順番が違う');
  // データ行は引用符の判定より前に数える
  assert.ok(body.indexOf('dataRows = dataRows + 1') < unclosed);
  assert.ok(/headerFields = fields/.test(body));
  const check = bodyOf('Private Function CheckQuoteCommas(');
  assert.ok(/newlines = CountChar\(cellText, vbLf\)/.test(check));
  assert.ok(/commas = CountChar\(cellText, ","\)/.test(check));
  assert.ok(/If commas >= headerCount - 1 Then/.test(check));
  assert.ok(/startLine = rec\(0\) \+ newlinesBefore/.test(check));
  assert.ok(/QuoteCommaMessage\(startLine, startLine \+ newlines, QuoteColumnName\(headerFields, k\), newlines, commas\)/.test(check));
});

test('VBA の設定: QUOTE_CHECK を TrimText のあと大文字にそろえ、キーがない・空なら TRUE。TRUE / FALSE 以外はエラー。SetupSettings で作る', () => {
  const read = bodyOf('Private Function ReadSettings(');
  assert.ok(/result\(key\) = TrimText\(CStr\(ws\.Cells\(r, 2\)\.Value\)\)/.test(read), '値を TrimText していない');
  assert.ok(/"DEDUPE", "QUOTE_CHECK"\)\s+If Not result\.Exists\(k\) Then result\(k\) = ""/.test(read), 'キーがないときの扱いがない');
  const upper = read.indexOf('result("QUOTE_CHECK") = UCase$(result("QUOTE_CHECK"))');
  const dflt = read.indexOf('If result("QUOTE_CHECK") = "" Then result("QUOTE_CHECK") = "TRUE"');
  assert.ok(upper >= 0 && dflt >= 0);
  const valid = bodyOf('Private Function ValidateSettings(');
  assert.ok(valid.includes('If settings("QUOTE_CHECK") <> "TRUE" And settings("QUOTE_CHECK") <> "FALSE" Then'));
  assert.ok(valid.includes('"・QUOTE_CHECK は TRUE か FALSE にしてください"'));
  const defaults = bodyOf('Private Function DefaultSettings(');
  assert.ok(/Array\("QUOTE_CHECK", "TRUE", "TRUE なら、/.test(defaults));
  assert.ok(/Array\("COL_ORDER_ID", "注文番号", "[^"]*DEDUPE を FALSE に"\)/.test(defaults), 'COL_ORDER_ID の説明に DEDUPE の注意がない');
  assert.ok(bodyOf('Public Sub SetupSettings(').includes('If key = "DEDUPE" Or key = "QUOTE_CHECK" Then SetDropDown ws.Cells(r, 2), "TRUE,FALSE"'));
  assert.ok(bodyOf('Public Sub RunAggregation(').includes('NormalizeRows CStr(names(i)), ParseCsv(text), colNames, settings("QUOTE_CHECK") = "TRUE", allRows,'));
});

test('VBA の取り込み結果: 実行日時のセルは、値を入れる前に文字列の書式にする', () => {
  const body = bodyOf('Private Sub WriteReports(');
  const fmt = body.indexOf('ws.Cells(reports.Count + 3, 2).NumberFormat = "@"');
  const val = body.indexOf('ws.Cells(reports.Count + 3, 2).Value');
  assert.ok(fmt >= 0 && val > fmt);
});

test('VBA のソースに波ダッシュ（〜 U+301C）も全角チルダ（～ U+FF5E）もない', () => {
  lines.forEach((l, i) => assert.ok(!l.includes('\u301c') && !l.includes('\uff5e'), `${i + 1} 行目`));
});

test('かっこ付きで呼んでいる関数は、VBA の組み込み関数か、このファイルで定義したもの（定義し忘れはコンパイルエラー）', () => {
  // engineer が 5.5 の実装で CountChar を定義し忘れ、他の静的チェックでは気づけなかったため追加
  const BUILTIN = ['Array', 'AscW', 'CLng', 'CStr', 'ChrW', 'CreateObject', 'Fix', 'Format', 'InStr', 'IsNull', 'LBound', 'LCase', 'Left', 'Len',
    'Mid', 'RGB', 'Replace', 'Right', 'Split', 'StrComp', 'UBound', 'UCase', 'Val'];
  const defined = new Set([...source.matchAll(/^(?:Public |Private )?(?:Sub|Function) (\w+)/gm)].map((m) => m[1]));
  code.forEach((l, i) => {
    for (const m of l.matchAll(/(?<![.\w])([A-Z]\w*)\$?\(/g)) {
      assert.ok(defined.has(m[1]) || BUILTIN.includes(m[1]), `${i + 1} 行目: ${m[1]} が定義されていない`);
    }
  });
});

test('VBA の NormalizeRows: 見出しのレコードも判定 A・B の対象にし、当たったら列を探さずに終える（audit 3 回目 必須 1）', () => {
  const body = bodyOf('Private Sub NormalizeRows(');
  const header = body.indexOf('headerFields = fields');
  const branch = body.slice(header, body.indexOf('Set missing = New Collection'));
  assert.ok(/If rec\(2\) = 0 Then\s+If rec\(5\) >= 0 Then\s+errors\.Add Array\(fileName, rec\(3\), QuoteTailMessage\(rec\(3\), rec\(4\), QuoteColumnName\(headerFields, rec\(5\)\)\)\)\s+quoteError = True\s+ElseIf quoteCheck Then\s+quoteError = CheckQuoteCommas\(fileName, rec, headerFields, errors\)\s+End If\s+If quoteError Then\s+SortErrorsByLine errors, firstError\s+Exit Sub/.test(branch),
    '見出しの分岐で判定 A・B をしていない');
  // FindColumns より前
  assert.ok(header >= 0 && body.indexOf('cols = FindColumns(') > header + branch.length - 1);
});

test('VBA の NormalizeRows: このファイルのエラーを、どの終わり方でも SortErrorsByLine で行番号の順に並べる（テスト 3 回目 気づいたこと 1）', () => {
  const body = bodyOf('Private Sub NormalizeRows(');
  assert.ok(/firstError = errors\.Count \+ 1/.test(body));
  assert.ok(body.indexOf('firstError = errors.Count + 1') < body.indexOf('UNCLOSED_QUOTE_MESSAGE'), '閉じていない引用符を足した後に記録している');
  // Exit Sub の直前と、最後（End Sub の直前）で並べる
  const exits = [...body.matchAll(/Exit Sub/g)].length;
  const sortedExits = [...body.matchAll(/SortErrorsByLine errors, firstError\s+Exit Sub/g)].length;
  assert.equal(sortedExits, exits, '並べずに終わる Exit Sub がある');
  assert.ok(/SortErrorsByLine errors, firstError\s*$/.test(body.trimEnd()), '最後に並べていない');
  const sort = bodyOf('Private Sub SortErrorsByLine(');
  assert.ok(/If list\(j\)\(1\) <= entry\(1\) Then Exit Do/.test(sort), '同じ行の順番を保っていない（安定でない）');
  assert.ok(/errors\.Remove firstIndex/.test(sort));
});
