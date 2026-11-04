'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../hearing-lib.js');

const DIR = path.join(__dirname, '..');
// 見本以外のアドレスは、書き出しの検査に引っかからないように組み立てる
const at = (user, domain) => user + '@' + domain;

function inquiry(over) {
  return Object.assign({
    plan: 'premium',
    google_account: 'personal',
    fields: [{ name: 'お名前', kind: 'text' }, { name: 'お問い合わせの種類', kind: 'choice' }, { name: '', kind: 'text' }],
    notify_to: 'tanto@example.com',
    auto_reply_subject: 'お問い合わせを受け付けました',
    auto_reply_body: '山田 太郎 様\nお問い合わせありがとうございます。',
    id_format: '',
    routing: '「お問い合わせの種類」が「見積もり」なら sales@example.com へ',
    deadline: '',
    notes: '',
  }, over);
}

function invoice(over) {
  return Object.assign({
    plan: 'premium',
    google_account: 'workspace',
    line_items: [{ name: '請求月' }, { name: '品目' }, { name: '  ' }],
    source: 'sheet',
    issuer_fields: ['name', 'registration_number', 'bank'],
    due_rule: 'next_month_end',
    due_days: '',
    rounding: 'floor',
    draft_subject: '11 月分のご請求書',
    draft_body: '見本商事 御中\n請求書を添付します。',
    logo: 'no',
    deadline: '11 月 20 日ごろ',
    notes: '',
  }, over);
}

// ---------- 必須の欄がプランで変わる ----------

test('A: 必須の欄はプランで変わる', () => {
  const base = ['plan', 'google_account', 'fields', 'notify_to'];
  assert.deepEqual(lib.requiredKeys('inquiry', { plan: 'basic' }), base);
  assert.deepEqual(lib.requiredKeys('inquiry', { plan: 'standard' }), [...base.slice(0, 4), 'auto_reply_subject', 'auto_reply_body']);
  assert.deepEqual(lib.requiredKeys('inquiry', { plan: 'premium' }), [...base, 'auto_reply_subject', 'auto_reply_body', 'routing']);
  assert.deepEqual(lib.requiredKeys('inquiry', {}), base, 'プランを選ぶ前はプランで出る質問を必須にしない');
});

test('A: プランに合わない質問は隠す', () => {
  assert.equal(lib.isVisible('inquiry', 'auto_reply_body', { plan: 'basic' }), false);
  assert.equal(lib.isVisible('inquiry', 'auto_reply_body', { plan: 'standard' }), true);
  assert.equal(lib.isVisible('inquiry', 'routing', { plan: 'standard' }), false);
  assert.equal(lib.isVisible('inquiry', 'routing', { plan: 'premium' }), true);
  assert.equal(lib.isVisible('inquiry', 'id_format', { plan: 'basic' }), true);
});

test('B: 必須の欄はプランと支払期限で変わる', () => {
  const base = ['plan', 'google_account', 'line_items', 'source', 'issuer_fields', 'due_rule', 'rounding'];
  assert.deepEqual(lib.requiredKeys('invoice', { plan: 'basic' }), base);
  assert.deepEqual(lib.requiredKeys('invoice', { plan: 'standard' }), [...base, 'draft_subject', 'draft_body']);
  assert.deepEqual(lib.requiredKeys('invoice', { plan: 'premium' }), [...base, 'draft_subject', 'draft_body', 'logo']);
  assert.ok(lib.requiredKeys('invoice', { plan: 'basic', due_rule: 'days' }).includes('due_days'));
  assert.equal(lib.isVisible('invoice', 'logo', { plan: 'standard' }), false);
});

// ---------- 足りない欄の一覧 ----------

test('足りない欄の名前を順に返し、文章は作らない', () => {
  const r = lib.buildSummary('inquiry', { plan: 'standard', fields: [{ name: ' ', kind: 'text' }] });
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.deepEqual(r.missing, ['Google アカウントの種類', 'フォームの質問項目', '担当者への通知先', '自動返信の件名', '自動返信の本文']);
});

test('隠れている欄は空でも足りない欄に入らない', () => {
  const a = inquiry({ plan: 'basic', auto_reply_subject: '', auto_reply_body: '', routing: '' });
  assert.deepEqual(lib.missingFields('inquiry', a), []);
  const b = invoice({ plan: 'basic', draft_subject: '', draft_body: '', logo: '' });
  assert.deepEqual(lib.missingFields('invoice', b), []);
});

test('B: 足りない欄（チェック・行・日数）', () => {
  const a = invoice({ issuer_fields: [], line_items: [{ name: '' }], due_rule: 'days', due_days: '0' });
  assert.deepEqual(lib.missingFields('invoice', a), ['明細の項目', '発行者の情報の項目', '発行日から何日か']);
  assert.deepEqual(lib.missingFields('invoice', invoice({ due_rule: 'days', due_days: '30' })), []);
});

test('プランが空なら「プラン」が足りない', () => {
  assert.equal(lib.missingFields('inquiry', inquiry({ plan: '' }))[0], 'プラン');
});

// ---------- 2 つの部分の形 ----------

function split(text) {
  const i = text.indexOf(lib.DEV_LINE);
  assert.ok(i > 0, '開発用の行がある');
  assert.equal(text.split(lib.DEV_LINE).length, 2, '開発用の行は 1 つだけ');
  return { human: text.slice(0, i), dev: text.slice(i + lib.DEV_LINE.length + 1) };
}
function topKeys(dev) {
  return dev.split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
}

test('開発用の行は決まった文字', () => {
  assert.equal(lib.DEV_LINE, '----- 開発用（このまま貼ってください）-----');
});

for (const plan of lib.PLAN_ORDER) {
  test(`A ${plan}: 2 つの部分に分かれ、開発用のキーがそろう`, () => {
    const r = lib.buildSummary('inquiry', inquiry({ plan }));
    assert.equal(r.ok, true);
    const { human, dev } = split(r.text);
    assert.match(human, /^【ヒアリングの回答】A 問い合わせ受付の自動化/);
    assert.match(human, /■ プラン\n・/);
    assert.match(human, /・お名前（記述式）\n・お問い合わせの種類（ラジオボタン）/);
    assert.match(human, /■ フォームの質問項目（2 件）/);
    assert.deepEqual(topKeys(dev), lib.DEV_KEYS.inquiry);
    assert.match(dev, new RegExp(`^job_type: inquiry\nplan: ${plan}\ngoogle_account: personal\n`));
    assert.match(dev, /fields:\n {2}- name: "お名前"\n {4}type: text\n {2}- name: "お問い合わせの種類"\n {4}type: choice\n/);
    if (plan === 'basic') {
      assert.doesNotMatch(human, /自動返信|振り分け/);
      assert.match(dev, /\nauto_reply: null\n/);
      assert.match(dev, /\nrouting: null\n/);
    } else {
      assert.match(dev, /\nauto_reply:\n {2}subject: "お問い合わせを受け付けました"\n {2}body: "山田 太郎 様\\nお問い合わせありがとうございます。"\n/);
    }
    if (plan === 'premium') assert.match(human, /■ 振り分けの条件/);
    else assert.doesNotMatch(human, /振り分け/);
  });

  test(`B ${plan}: 2 つの部分に分かれ、開発用のキーがそろう`, () => {
    const r = lib.buildSummary('invoice', invoice({ plan }));
    assert.equal(r.ok, true);
    const { human, dev } = split(r.text);
    assert.match(human, /^【ヒアリングの回答】B 請求書 PDF の自動作成/);
    assert.match(human, /■ 明細の項目（2 件）\n・請求月\n・品目\n/);
    assert.match(human, /・登録番号（インボイス）/);
    assert.match(human, /■ 請求書の見本\n・このメッセージに添付します/);
    assert.deepEqual(topKeys(dev), lib.DEV_KEYS.invoice);
    assert.match(dev, /line_items:\n {2}- "請求月"\n {2}- "品目"\nsource: sheet\nissuer_fields:\n {2}- name\n {2}- registration_number\n {2}- bank\n/);
    assert.match(dev, /due_rule:\n {2}type: next_month_end\n {2}days: null\nrounding: floor\n/);
    assert.match(dev, /\nsample: attach_in_message\n/);
    assert.match(dev, plan === 'basic' ? /\ndraft: null\n/ : /\ndraft:\n {2}subject: "11 月分のご請求書"\n/);
    assert.match(dev, plan === 'premium' ? /\nlogo: no\n/ : /\nlogo: null\n/);
  });
}

test('B: 発行日から◯日は日数を数で書く', () => {
  const r = lib.buildSummary('invoice', invoice({ due_rule: 'days', due_days: '30' }));
  assert.match(r.text, /・支払期限: 発行日から 30 日/);
  assert.match(r.text, /due_rule:\n {2}type: days\n {2}days: 30\n/);
});

test('開発用の文字列は引用符・改行を崩さない（JSON として読める）', () => {
  const r = lib.buildSummary('inquiry', inquiry({ notes: '「"引用"」\nと \\ の行' }));
  const line = r.text.split('\n').find((l) => l.startsWith('notes: '));
  assert.equal(JSON.parse(line.slice('notes: '.length)), '「"引用"」\nと \\ の行');
  assert.match(r.text, /\nnotes: null\n|notes: "/);
});

test('空の任意の欄は、読む部分で「特になし」、開発用で null', () => {
  const r = lib.buildSummary('inquiry', inquiry());
  assert.match(r.text, /■ 希望の納期\n・特になし/);
  assert.match(r.text, /\ndeadline: null\n/);
  assert.match(r.text, /\nid_format: null\n/);
  assert.match(r.text, /\nnotes: null\n$/);
});

test('開発用の部分は日本語のキーを使わず、行は「キー: 値」か一覧', () => {
  for (const [job, a] of [['inquiry', inquiry()], ['invoice', invoice()]]) {
    const { dev } = split(lib.buildSummary(job, a).text);
    for (const l of dev.trim().split('\n')) {
      assert.match(l, /^(?: {2}| {4})?(?:- )?(?:[a-z_]+:(?: .*)?|".*"|[a-z_]+)$/, l);
    }
  }
});

// ---------- 注意の検査 ----------

test('メールアドレスの欄: example.com・example.org だけなら注意しない', () => {
  assert.deepEqual(lib.findWarnings('inquiry', inquiry({ notify_to: `a@example.com, ${at('b', 'sub.example.org')}` })), []);
  assert.equal(lib.isSampleEmailList('a@example.com、b@example.org'), true);
});

test('メールアドレスの欄: 見本以外や形の違う値は注意するが、文章は作る', () => {
  for (const v of [at('taro', 'company.co.jp'), 'tanto', at('a', 'example.com.evil.jp'), at('a', 'notexample.com')]) {
    const r = lib.buildSummary('inquiry', inquiry({ notify_to: v }));
    assert.equal(r.ok, true, v);
    assert.equal(r.warnings.length, 1, v);
    assert.match(r.warnings[0], /担当者への通知先/);
    assert.match(r.warnings[0], /本番のアドレスは最後にご自身で設定/);
    assert.match(r.warnings[0], /見本の値にしてください/);
  }
});

test('本文の中の、見本ではないメールアドレスを注意する', () => {
  const w = lib.findWarnings('inquiry', inquiry({ auto_reply_body: `返信は ${at('yamada', 'company.co.jp')} へ` }));
  assert.equal(w.length, 1);
  assert.match(w[0], /自動返信の本文.*yamada.company\.co\.jp/);
  assert.deepEqual(lib.findWarnings('inquiry', inquiry({ auto_reply_body: '返信は info@example.com へ' })), []);
});

test('電話番号らしいものを注意する（全角・国番号も）', () => {
  for (const t of ['お電話は 03-1234-5678 まで', '０９０－１２３４－５６７８', 'TEL: 090 1234 5678', '+81 90-1234-5678', '0120-123-456', '(03)1234-5678']) {
    assert.equal(lib.findContactLike(t).phones.length, 1, t);
  }
  const w = lib.findWarnings('invoice', invoice({ draft_body: 'ご不明点は 06-1234-5678 まで' }));
  assert.equal(w.length, 1);
  assert.match(w[0], /下書きの本文.*電話番号らしいもの/);
});

test('電話番号ではないもの（受付番号・日付・金額）は注意しない', () => {
  for (const t of ['INQ-20261026-001', '2026-11-03', '¥10,000', '30 日', '2026年01月05日 03:00']) {
    assert.deepEqual(lib.findContactLike(t).phones, [], t);
  }
});

test('URL らしいものを注意する（example のものは除く）', () => {
  for (const t of ['https://company.co.jp/contact', 'http://a.test/x', 'www.company.jp', 'company.com を見てください']) {
    assert.ok(lib.findContactLike(t).urls.length >= 1, t);
  }
  for (const t of ['https://example.com/form', 'www.example.org', '請求書.pdf を添付', 'a@example.com']) {
    assert.deepEqual(lib.findContactLike(t).urls, [], t);
  }
  const w = lib.findWarnings('inquiry', inquiry({ notes: '今のフォーム: https://forms.gle/abc' }));
  assert.equal(w.length, 1);
  assert.match(w[0], /そのほか.*URL らしいもの/);
});

test('隠れている欄は注意の検査もしない', () => {
  assert.deepEqual(lib.findWarnings('inquiry', inquiry({ plan: 'basic', auto_reply_body: '03-1234-5678' })), []);
});

// ---------- 質問名のまとめて貼り付け ----------

test('parseQuestionLines: 空の行・前後の空白・重複を除く', () => {
  assert.deepEqual(lib.parseQuestionLines('  お名前 \n\n\tメールアドレス\r\nお名前\r\n   \nお問い合わせ内容'), ['お名前', 'メールアドレス', 'お問い合わせ内容']);
  assert.deepEqual(lib.parseQuestionLines(''), []);
  assert.deepEqual(lib.parseQuestionLines(undefined), []);
  assert.deepEqual(lib.parseQuestionLines('\n \n'), []);
});

test('parseQuestionLines: 箇条書きの記号・番号と、末尾の必須の印を外す', () => {
  const text = ['・お名前 *', '- メールアドレス*', '* 電話番号', '1. ご住所', '2) 会社名', '（3）部署名', '① お問い合わせの種類', '１．ご希望の日時 ＊', '• 備考', '- 1. 年齢'].join('\n');
  assert.deepEqual(lib.parseQuestionLines(text), ['お名前', 'メールアドレス', '電話番号', 'ご住所', '会社名', '部署名', 'お問い合わせの種類', 'ご希望の日時', '備考', '年齢']);
});

test('parseQuestionLines: 質問名の中の数字や記号は残す', () => {
  assert.deepEqual(lib.parseQuestionLines('2026年の予算\n1.5 倍にしたい理由\nA/B のどちら\n※注意事項'), ['2026年の予算', '1.5 倍にしたい理由', 'A/B のどちら', '※注意事項']);
  assert.deepEqual(lib.parseQuestionLines('*\n・\n1.'), [], '記号だけの行は空の行として除く');
});

test('parseQuestionLines: 最大 30 件', () => {
  const text = Array.from({ length: 40 }, (_, i) => '質問' + (i + 1)).join('\n');
  const r = lib.parseQuestionLines(text);
  assert.equal(lib.MAX_QUESTION_LINES, 30);
  assert.equal(r.length, 30);
  assert.equal(r[29], '質問30');
  assert.equal(lib.parseQuestionLines('a\na\n' + text).length, 30, '重複は数えない');
});

// ---------- フォームの URL ----------

const FORM = 'https://forms.gle/AbCdEf123';
const FORM_LONG = 'https://docs.google.com/forms/d/e/1FAIpQLSexample/viewform';

test('フォームの URL があれば、質問項目は空でも足りない欄にならない', () => {
  const empty = [{ name: '', kind: 'text' }];
  assert.deepEqual(lib.missingFields('inquiry', inquiry({ fields: empty })), ['フォームの質問項目']);
  assert.deepEqual(lib.missingFields('inquiry', inquiry({ fields: empty, form_url: FORM })), []);
  assert.deepEqual(lib.missingFields('inquiry', inquiry({ fields: empty, form_url: '  ' })), ['フォームの質問項目'], '空白だけは空');
  assert.deepEqual(lib.missingFields('inquiry', inquiry({ form_url: '' })), [], '質問項目があれば URL は要らない');
});

test('フォームの URL の形: docs.google.com/forms/ と forms.gle/ だけを受け付ける', () => {
  for (const u of [FORM, FORM_LONG, ' ' + FORM + ' ']) {
    assert.equal(lib.isFormUrl(u), true, u);
    assert.deepEqual(lib.missingFields('inquiry', inquiry({ form_url: u })), [], u);
  }
  for (const u of ['http://forms.gle/abc', 'https://forms.gle/', 'forms.gle/abc', 'https://docs.google.com/document/d/x', 'https://forms.gle.evil.jp/x', 'https://company.co.jp/form', 'https://forms.gle/a b', 'フォームはあります']) {
    assert.equal(lib.isFormUrl(u), false, u);
    const r = lib.buildSummary('inquiry', inquiry({ fields: [], form_url: u }));
    assert.equal(r.ok, false, u);
    assert.deepEqual(r.missing, [lib.FORM_URL_INVALID], u + '（形が違う URL では質問項目の代わりにならない）');
  }
  assert.equal(lib.FORM_URL_INVALID, 'Google フォームの公開用の URL を貼ってください');
});

test('フォームの URL: 編集用の URL は注意し、文章は作る', () => {
  const edit = 'https://docs.google.com/forms/d/1AbCexample/edit';
  for (const u of [edit, edit + '#responses', edit + '?usp=sharing']) {
    const r = lib.buildSummary('inquiry', inquiry({ fields: [], form_url: u }));
    assert.equal(r.ok, true, u);
    assert.equal(r.warnings.length, 1, u);
    assert.match(r.warnings[0], /回答用の URL（右上の「送信」→リンク）にしてください/);
  }
  assert.equal(lib.isEditFormUrl(FORM_LONG), false);
});

test('フォームの URL の欄は、URL らしいものの注意をしない', () => {
  assert.deepEqual(lib.findWarnings('inquiry', inquiry({ form_url: FORM })), []);
  assert.deepEqual(lib.findWarnings('inquiry', inquiry({ form_url: FORM_LONG })), []);
  assert.equal(lib.findWarnings('inquiry', inquiry({ form_url: FORM, notes: '前のフォーム: ' + FORM })).length, 1, 'ほかの欄の URL は今までどおり注意する');
});

test('フォームの URL: 読む部分と開発用の部分', () => {
  const r = lib.buildSummary('inquiry', inquiry({ fields: [], form_url: FORM }));
  assert.equal(r.ok, true);
  const { human, dev } = split(r.text);
  assert.match(human, /■ フォームの質問項目\n・フォームの URL: https:\/\/forms\.gle\/AbCdEf123（質問名はこちらで読み取ります）\n/);
  assert.match(dev, /\nfields: \[\]\nform_url: "https:\/\/forms\.gle\/AbCdEf123"\n/);
  const both = lib.buildSummary('inquiry', inquiry({ form_url: FORM }));
  assert.match(both.text, /■ フォームの質問項目（2 件）\n・お名前（記述式）\n・お問い合わせの種類（ラジオボタン）\n・フォームの URL: /);
  const none = lib.buildSummary('inquiry', inquiry());
  assert.match(none.text, /\nform_url: null\n/);
  assert.doesNotMatch(none.text, /フォームの URL/);
});

// ---------- 外部への送信がないこと（静的テスト） ----------

const pageFiles = fs.readdirSync(DIR).filter((f) => /\.(html|js)$/.test(f));
const htmlFiles = pageFiles.filter((f) => f.endsWith('.html'));

test('ページのファイルがそろっている', () => {
  for (const f of ['index.html', 'inquiry.html', 'invoice.html', 'hearing-lib.js', 'hearing-ui.js', 'hearing.css']) {
    assert.ok(fs.existsSync(path.join(DIR, f)), f);
  }
});

test('html と js に、外へ送る処理・保存する処理がない', () => {
  const banned = ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'sendBeacon', 'WebSocket', 'EventSource', 'import(', '<form', 'mailto:', 'window.open', 'location.href', '<iframe'];
  for (const f of pageFiles.concat(['hearing.css'])) {
    const s = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const b of banned) assert.equal(s.includes(b), false, `${f} に ${b}`);
  }
});

test('外部のスクリプト・スタイル・フォントを読み込まず、リンクは相対だけ', () => {
  for (const f of htmlFiles) {
    const s = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.doesNotMatch(s, /https?:\/\//, `${f} に http(s):// がある`);
    const refs = [...s.matchAll(/\b(?:href|src|action)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]);
    assert.ok(refs.length > 0, f);
    for (const r of refs) {
      assert.doesNotMatch(r, /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i, `${f} のリンクが相対ではない: ${r}`);
      assert.ok(fs.existsSync(path.join(DIR, r.split('#')[0] || '.')), `${f} のリンク先がない: ${r}`);
    }
  }
  const css = fs.readFileSync(path.join(DIR, 'hearing.css'), 'utf8');
  assert.doesNotMatch(css, /@import|url\(|@font-face/);
});

test('各ページで、通信と送信を止める CSP を置く', () => {
  for (const f of htmlFiles) {
    const s = fs.readFileSync(path.join(DIR, f), 'utf8');
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(s);
    assert.ok(m, f);
    for (const d of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "script-src 'self'"]) {
      assert.ok(m[1].includes(d), `${f}: ${d}`);
    }
  }
});

test('各ページに「ランサーズのメッセージに貼って送ってください」がある', () => {
  for (const f of htmlFiles) {
    assert.ok(fs.readFileSync(path.join(DIR, f), 'utf8').includes('答えはランサーズのメッセージに貼って送ってください。'), f);
  }
});

test('質問のページは、lib のすべての質問の欄と、ボタン・文章の欄を持つ', () => {
  for (const job of ['inquiry', 'invoice']) {
    const s = fs.readFileSync(path.join(DIR, job + '.html'), 'utf8');
    assert.ok(s.includes(`data-job="${job}"`));
    for (const q of lib.questions(job)) assert.ok(s.includes(`data-q="${q.key}"`), `${job}: ${q.key}`);
    for (const id of ['build', 'copy', 'out']) assert.ok(s.includes(`id="${id}"`), `${job}: ${id}`);
    assert.doesNotMatch(s, /type="file"/, 'ファイルの選択は置かない');
  }
});

test('A のページに、まとめて貼る欄と、URL の欄（リンクにしない）がある', () => {
  const s = fs.readFileSync(path.join(DIR, 'inquiry.html'), 'utf8');
  for (const id of ['paste', 'paste-rows', 'form_url']) assert.ok(s.includes(`id="${id}"`), id);
  assert.ok(s.includes('質問名を 1 行に 1 つずつ貼ってください'));
  assert.ok(s.includes('>行にする<'));
  assert.ok(s.includes('公開中のフォームの URL を書いていただければ、こちらで開いて質問名を読み取ります。その場合は 03 を空のままにして構いません。'));
  assert.match(s, /<input type="text" id="form_url"/, 'URL の欄は type="url" にしない（ただの文字）');
  const ui = fs.readFileSync(path.join(DIR, 'hearing-ui.js'), 'utf8');
  assert.doesNotMatch(ui, /\.href\b|setAttribute\(\s*['"]href|createElement\(\s*['"]a['"]|innerHTML/, 'URL をリンクにしない');
  // 種類の初期値は、いちばん上の選択肢（記述式）
  assert.match(s, /<select data-part="kind"[^>]*>\s*<option value="text">記述式<\/option>/);
});

test('docs/hearing は CI の matrix に入っている', () => {
  const ci = fs.readFileSync(path.join(DIR, '..', '..', '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /project: \[[^\]]*docs\/hearing/);
});
