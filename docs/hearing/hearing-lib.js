// ヒアリングのページで使う純粋関数（DOM も通信も使わない）。
// ブラウザでは window.HearingLib、Node では module.exports で使う。
(function (root) {
  'use strict';

  const PLAN_ORDER = ['basic', 'standard', 'premium'];
  const PLAN_LABELS = { basic: 'ベーシック', standard: 'スタンダード', premium: 'プレミアム' };
  const JOB_LABELS = { inquiry: 'A 問い合わせ受付の自動化', invoice: 'B 請求書 PDF の自動作成' };

  const ACCOUNT_LABELS = { personal: '個人のアカウント', workspace: '会社・学校のアカウント' };
  const FIELD_KINDS = {
    text: '記述式',
    paragraph: '段落',
    choice: 'ラジオボタン',
    checkbox: 'チェックボックス',
    dropdown: 'プルダウン',
    date: '日付',
    other: 'その他',
  };
  const SOURCE_LABELS = { sheet: 'Google スプレッドシート', excel: 'Excel', other: 'その他' };
  const ISSUER_LABELS = {
    name: '会社名・屋号',
    address: '住所',
    phone: '電話番号',
    email: 'メールアドレス',
    registration_number: '登録番号（インボイス）',
    bank: '振込先',
    contact_person: '担当者名',
    other: 'その他',
  };
  const DUE_LABELS = { next_month_end: '翌月末', month_end: '当月末', days: '発行日から◯日', other: 'その他' };
  const ROUNDING_LABELS = { floor: '切り捨て', round: '四捨五入', ceil: '切り上げ' };
  const LOGO_LABELS = { yes: '使う', no: '使わない' };

  const atLeast = (min) => (a) => PLAN_ORDER.indexOf(a.plan) >= PLAN_ORDER.indexOf(min);

  // 質問の定義。required: 必須か。show: 出す条件（なければいつも出す）。
  const COMMON_HEAD = [
    { key: 'plan', label: 'プラン', type: 'choice', required: true },
    { key: 'google_account', label: 'Google アカウントの種類', type: 'choice', required: true },
  ];
  const COMMON_TAIL = [
    { key: 'deadline', label: '希望の納期', type: 'text', required: false },
    { key: 'notes', label: 'そのほか', type: 'text', required: false },
  ];
  const QUESTIONS = {
    inquiry: [
      ...COMMON_HEAD,
      { key: 'fields', label: 'フォームの質問項目', type: 'rows', required: true, orKey: 'form_url' },
      { key: 'form_url', label: 'フォームの URL', type: 'url', required: false },
      { key: 'notify_to', label: '担当者への通知先', type: 'email', required: true },
      { key: 'auto_reply_subject', label: '自動返信の件名', type: 'text', required: true, show: atLeast('standard') },
      { key: 'auto_reply_body', label: '自動返信の本文', type: 'text', required: true, show: atLeast('standard') },
      { key: 'id_format', label: '受付番号の形', type: 'text', required: false },
      { key: 'routing', label: '振り分けの条件', type: 'text', required: true, show: atLeast('premium') },
      ...COMMON_TAIL,
    ],
    invoice: [
      ...COMMON_HEAD,
      { key: 'line_items', label: '明細の項目', type: 'rows', required: true },
      { key: 'source', label: '今の明細の置き場所', type: 'choice', required: true },
      { key: 'issuer_fields', label: '発行者の情報の項目', type: 'checks', required: true },
      { key: 'due_rule', label: '支払期限', type: 'choice', required: true },
      { key: 'due_days', label: '発行日から何日か', type: 'number', required: true, show: (a) => a.due_rule === 'days' },
      { key: 'rounding', label: '端数処理', type: 'choice', required: true },
      { key: 'draft_subject', label: '下書きの件名', type: 'text', required: true, show: atLeast('standard') },
      { key: 'draft_body', label: '下書きの本文', type: 'text', required: true, show: atLeast('standard') },
      { key: 'logo', label: 'ロゴを使うか', type: 'choice', required: true, show: atLeast('premium') },
      ...COMMON_TAIL,
    ],
  };

  function questions(jobType) {
    const q = QUESTIONS[jobType];
    if (!q) throw new Error('job_type が違います: ' + jobType);
    return q;
  }

  function str(v) {
    return v === undefined || v === null ? '' : String(v).trim();
  }

  // 空の行を除いた行の一覧
  function rows(v) {
    return (Array.isArray(v) ? v : [])
      .map((r) => ({ name: str(r && r.name), kind: str(r && r.kind) }))
      .filter((r) => r.name !== '');
  }

  function isVisible(jobType, key, answers) {
    const q = questions(jobType).find((x) => x.key === key);
    if (!q) return false;
    return q.show ? q.show(answers || {}) : true;
  }

  function visibleQuestions(jobType, answers) {
    return questions(jobType).filter((q) => (q.show ? q.show(answers || {}) : true));
  }

  function requiredKeys(jobType, answers) {
    return visibleQuestions(jobType, answers).filter((q) => q.required).map((q) => q.key);
  }

  // ---------- フォームの URL（ただの文字として扱い、開かない） ----------

  const FORM_URL_RE = /^(?:https:\/\/docs\.google\.com\/forms\/|https:\/\/forms\.gle\/)\S+$/;
  const FORM_URL_INVALID = 'Google フォームの公開用の URL を貼ってください';

  function isFormUrl(v) {
    return FORM_URL_RE.test(str(v));
  }

  function isEditFormUrl(v) {
    return isFormUrl(v) && /\/edit(?:[/?#]|$)/.test(str(v));
  }

  // ---------- 質問名のまとめて貼り付け ----------

  const MAX_QUESTION_LINES = 30;
  const BULLET_RE = /^[・\-*＊•●○◯■□◆◇▪▫►▸‐－–—]+\s*/;
  const NUMBER_RE = /^(?:[(（]\s*[0-9０-９]{1,3}\s*[)）]|[0-9０-９]{1,3}\s*[.．、)）:：](?![0-9０-９])|[①-⑳㉑-㉟])\s*/;
  const REQUIRED_MARK_RE = /\s*[*＊]+$/;

  // 1 行に 1 つの質問名を、行の名前の一覧にする（記号・番号・必須の印・空の行・重複を除く）
  function parseQuestionLines(text) {
    const out = [];
    for (const line of String(text === undefined || text === null ? '' : text).split(/\r\n|\r|\n/)) {
      let s = line.trim();
      for (let i = 0; i < 2; i++) s = s.replace(BULLET_RE, '').replace(NUMBER_RE, '');
      s = s.replace(REQUIRED_MARK_RE, '').trim();
      if (s === '' || out.includes(s)) continue;
      out.push(s);
      if (out.length >= MAX_QUESTION_LINES) break;
    }
    return out;
  }

  function isEmpty(q, v) {
    if (q.type === 'rows') return rows(v).length === 0;
    if (q.type === 'checks') return !Array.isArray(v) || v.length === 0;
    if (q.type === 'number') return !/^[1-9][0-9]{0,2}$/.test(str(v));
    return str(v) === '';
  }

  // 必須なのに空の欄の名前の一覧
  function missingFields(jobType, answers) {
    const a = answers || {};
    const out = [];
    for (const q of visibleQuestions(jobType, a)) {
      if (q.required && isEmpty(q, a[q.key]) && !(q.orKey && str(a[q.orKey]) !== '')) out.push(q.label);
      if (q.type === 'url' && str(a[q.key]) !== '' && !isFormUrl(a[q.key])) out.push(FORM_URL_INVALID);
    }
    return out;
  }

  // ---------- 連絡先らしいものの検査 ----------

  const SAMPLE_DOMAIN = /^(?:[a-z0-9-]+\.)*example\.(?:com|org)$/i;
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
  const URL_RE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s"'<>（）「」、。]+/gi;
  const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|jp|io|co|info|biz|me|app|dev|link|site|xyz)\b(?:\/[^\s"'<>（）「」、。]*)?/gi;
  const PHONE_RE = /(?<![0-9A-Za-z])(?:\+81|0)[0-9()（）\-‐－ー\s]{7,16}[0-9]/g;

  function normalize(s) {
    return str(s).normalize('NFKC');
  }

  function hostOf(url) {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:?#]+)/i.exec(url);
    return m ? m[1] : '';
  }

  // テキストの中の、見本ではないメールアドレス・電話番号・URL らしいもの
  function findContactLike(text) {
    const s = normalize(text);
    const emails = [];
    let m;
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(s)) !== null) {
      if (!SAMPLE_DOMAIN.test(m[1])) emails.push(m[0]);
    }
    const noEmail = s.replace(EMAIL_RE, ' ');
    const urls = [];
    for (const u of noEmail.match(URL_RE) || []) {
      if (!SAMPLE_DOMAIN.test(hostOf(u))) urls.push(u);
    }
    const noUrl = noEmail.replace(URL_RE, ' ');
    for (const u of noUrl.match(BARE_DOMAIN_RE) || []) {
      if (!SAMPLE_DOMAIN.test(hostOf(u))) urls.push(u);
    }
    const phones = [];
    for (const p of noUrl.match(PHONE_RE) || []) {
      const digits = p.replace(/[^0-9]/g, '');
      const n = p.startsWith('+81') ? digits.length - 2 + 1 : digits.length;
      if (n >= 10 && n <= 11) phones.push(p.trim());
    }
    return { emails, phones, urls };
  }

  // メールアドレスの欄の値（複数はカンマ・読点・空白で区切る）が、すべて見本のアドレスか
  function isSampleEmailList(value) {
    const parts = normalize(value).split(/[,、;\s]+/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => {
      const m = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)$/.exec(p);
      return m !== null && SAMPLE_DOMAIN.test(m[1]);
    });
  }

  const EMAIL_NOTE = '本番のアドレスは最後にご自身で設定していただくので、ここは tanto@example.com のような見本の値にしてください。';
  const CONTACT_NOTE = '本番の値は最後にご自身で設定していただくので、「（電話番号）」「（URL）」のような書き方にしてください。';

  // 送る前に気をつけてほしいこと（止めはしない）
  function findWarnings(jobType, answers) {
    const a = answers || {};
    const out = [];
    for (const q of visibleQuestions(jobType, a)) {
      const v = a[q.key];
      if (q.type === 'email') {
        if (str(v) !== '' && !isSampleEmailList(v)) {
          out.push(`「${q.label}」に、example.com・example.org 以外の値があります。${EMAIL_NOTE}`);
        }
        continue;
      }
      if (q.type === 'url') {
        // この欄は URL を書く欄なので、URL らしいものの注意はしない
        if (isEditFormUrl(v)) out.push(`「${q.label}」は編集用の URL です。回答用の URL（右上の「送信」→リンク）にしてください。`);
        continue;
      }
      let text = '';
      if (q.type === 'text') text = str(v);
      else if (q.type === 'rows') text = rows(v).map((r) => r.name).join('\n');
      if (text === '') continue;
      const f = findContactLike(text);
      if (f.emails.length) out.push(`「${q.label}」に、見本ではないメールアドレスがあります（${f.emails.join('、')}）。${EMAIL_NOTE}`);
      if (f.phones.length) out.push(`「${q.label}」に、電話番号らしいものがあります（${f.phones.join('、')}）。${CONTACT_NOTE}`);
      if (f.urls.length) out.push(`「${q.label}」に、URL らしいものがあります（${f.urls.join('、')}）。${CONTACT_NOTE}`);
    }
    return out;
  }

  function validate(jobType, answers) {
    return { missing: missingFields(jobType, answers), warnings: findWarnings(jobType, answers) };
  }

  // ---------- 文章を作る ----------

  const DEV_LINE = '----- 開発用（このまま貼ってください）-----';
  const DEV_KEYS = {
    inquiry: ['job_type', 'plan', 'google_account', 'deadline', 'fields', 'form_url', 'notify_to', 'auto_reply', 'id_format', 'routing', 'notes'],
    invoice: ['job_type', 'plan', 'google_account', 'deadline', 'line_items', 'source', 'issuer_fields', 'due_rule', 'rounding', 'draft', 'logo', 'sample', 'notes'],
  };

  // YAML の値。文字列は JSON の形で書く（YAML のダブルクォートとして読める）
  function y(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return String(v);
    return JSON.stringify(String(v));
  }

  function indentBlock(text, pad) {
    return String(text).split('\n').map((l) => pad + l).join('\n');
  }

  function orNone(v, none) {
    return str(v) === '' ? none : str(v);
  }

  function humanCommonHead(jobType, a) {
    return [
      `【ヒアリングの回答】${JOB_LABELS[jobType]}`,
      '',
      '■ プラン',
      `・${PLAN_LABELS[a.plan]}`,
      '',
      '■ Google アカウント',
      `・${ACCOUNT_LABELS[a.google_account] || str(a.google_account)}`,
    ];
  }

  function humanCommonTail(a) {
    return [
      '',
      '■ 希望の納期',
      `・${orNone(a.deadline, '特になし')}`,
      '',
      '■ そのほか',
      str(a.notes) === '' ? '・なし' : indentBlock(str(a.notes), '  '),
    ];
  }

  function humanInquiry(a) {
    const show = (k) => isVisible('inquiry', k, a);
    const f = rows(a.fields);
    const lines = humanCommonHead('inquiry', a);
    lines.push('', f.length ? `■ フォームの質問項目（${f.length} 件）` : '■ フォームの質問項目');
    for (const r of f) lines.push(`・${r.name}（${FIELD_KINDS[r.kind] || FIELD_KINDS.other}）`);
    if (str(a.form_url) !== '') lines.push(`・フォームの URL: ${str(a.form_url)}（質問名はこちらで読み取ります）`);
    lines.push('', '■ 担当者への通知先', `・${str(a.notify_to)}`);
    if (show('auto_reply_subject')) {
      lines.push('', '■ 自動返信', `・件名: ${str(a.auto_reply_subject)}`, '・本文:', indentBlock(str(a.auto_reply_body), '  '));
    }
    lines.push('', '■ 受付番号の形', `・${orNone(a.id_format, '指定なし（例: INQ-20261026-001）')}`);
    if (show('routing')) lines.push('', '■ 振り分けの条件', indentBlock(str(a.routing), '  '));
    return lines.concat(humanCommonTail(a));
  }

  function dueText(a) {
    if (a.due_rule === 'days') return `発行日から ${str(a.due_days)} 日`;
    if (a.due_rule === 'other') return 'その他（「そのほか」に書きました）';
    return DUE_LABELS[a.due_rule] || str(a.due_rule);
  }

  function humanInvoice(a) {
    const show = (k) => isVisible('invoice', k, a);
    const items = rows(a.line_items);
    const issuer = Array.isArray(a.issuer_fields) ? a.issuer_fields : [];
    const lines = humanCommonHead('invoice', a);
    lines.push('', `■ 明細の項目（${items.length} 件）`);
    for (const r of items) lines.push(`・${r.name}`);
    lines.push('', '■ 今の明細の置き場所', `・${SOURCE_LABELS[a.source] || str(a.source)}`);
    lines.push('', '■ 発行者の情報として載せる項目');
    for (const k of issuer) lines.push(`・${ISSUER_LABELS[k] || k}`);
    lines.push('', '■ 支払期限と端数処理', `・支払期限: ${dueText(a)}`, `・端数処理: ${ROUNDING_LABELS[a.rounding] || str(a.rounding)}`);
    if (show('draft_subject')) {
      lines.push('', '■ 下書き', `・件名: ${str(a.draft_subject)}`, '・本文:', indentBlock(str(a.draft_body), '  '));
    }
    if (show('logo')) lines.push('', '■ ロゴ', `・${LOGO_LABELS[a.logo] || str(a.logo)}`);
    lines.push('', '■ 請求書の見本', '・このメッセージに添付します（宛名・金額は見本の値に置き換えたもの）');
    return lines.concat(humanCommonTail(a));
  }

  function devCommonHead(jobType, a) {
    return [
      `job_type: ${jobType}`,
      `plan: ${a.plan}`,
      `google_account: ${a.google_account}`,
      `deadline: ${str(a.deadline) === '' ? 'null' : y(str(a.deadline))}`,
    ];
  }

  function devNotes(a) {
    return `notes: ${str(a.notes) === '' ? 'null' : y(str(a.notes))}`;
  }

  function devInquiry(a) {
    const show = (k) => isVisible('inquiry', k, a);
    const lines = devCommonHead('inquiry', a);
    const f = rows(a.fields);
    lines.push(f.length ? 'fields:' : 'fields: []');
    for (const r of f) {
      lines.push(`  - name: ${y(r.name)}`, `    type: ${FIELD_KINDS[r.kind] ? r.kind : 'other'}`);
    }
    lines.push(`form_url: ${str(a.form_url) === '' ? 'null' : y(str(a.form_url))}`);
    lines.push(`notify_to: ${y(str(a.notify_to))}`);
    if (show('auto_reply_subject')) {
      lines.push('auto_reply:', `  subject: ${y(str(a.auto_reply_subject))}`, `  body: ${y(str(a.auto_reply_body))}`);
    } else {
      lines.push('auto_reply: null');
    }
    lines.push(`id_format: ${str(a.id_format) === '' ? 'null' : y(str(a.id_format))}`);
    lines.push(`routing: ${show('routing') ? y(str(a.routing)) : 'null'}`);
    lines.push(devNotes(a));
    return lines;
  }

  function devInvoice(a) {
    const show = (k) => isVisible('invoice', k, a);
    const lines = devCommonHead('invoice', a);
    lines.push('line_items:');
    for (const r of rows(a.line_items)) lines.push(`  - ${y(r.name)}`);
    lines.push(`source: ${a.source}`);
    lines.push('issuer_fields:');
    for (const k of a.issuer_fields || []) lines.push(`  - ${k}`);
    lines.push('due_rule:', `  type: ${a.due_rule}`, `  days: ${a.due_rule === 'days' ? Number(str(a.due_days)) : 'null'}`);
    lines.push(`rounding: ${a.rounding}`);
    if (show('draft_subject')) {
      lines.push('draft:', `  subject: ${y(str(a.draft_subject))}`, `  body: ${y(str(a.draft_body))}`);
    } else {
      lines.push('draft: null');
    }
    lines.push(`logo: ${show('logo') ? a.logo : 'null'}`);
    lines.push('sample: attach_in_message');
    lines.push(devNotes(a));
    return lines;
  }

  // 戻り値: { ok, missing, warnings, text }。必須の欄が空なら ok: false で text は ''。
  function buildSummary(jobType, answers) {
    const a = answers || {};
    const { missing, warnings } = validate(jobType, a);
    if (missing.length) return { ok: false, missing, warnings, text: '' };
    const human = jobType === 'inquiry' ? humanInquiry(a) : humanInvoice(a);
    const dev = jobType === 'inquiry' ? devInquiry(a) : devInvoice(a);
    const text = human.join('\n') + '\n\n' + DEV_LINE + '\n' + dev.join('\n') + '\n';
    return { ok: true, missing, warnings, text };
  }

  const api = {
    PLAN_ORDER, PLAN_LABELS, FIELD_KINDS, ISSUER_LABELS, DEV_LINE, DEV_KEYS,
    MAX_QUESTION_LINES, FORM_URL_INVALID, parseQuestionLines, isFormUrl, isEditFormUrl,
    questions, isVisible, visibleQuestions, requiredKeys, missingFields,
    findContactLike, isSampleEmailList, findWarnings, validate, buildSummary,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HearingLib = api;
})(typeof window !== 'undefined' ? window : this);
