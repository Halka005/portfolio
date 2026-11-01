/**
 * 自己テスト（開発用。**納品物には入れない**）。仕様: docs/specs/selftest.md（版 5）
 * テスト専用のスプレッドシート（名前が「自己テスト」で始まる）で、メニュー「受付ツール」→「自己テスト（開発用）」から動かす。
 * 「自己テスト_回答」シートに回答を 1 行ずつ足し、送信イベントを作って本番の処理（handleFormSubmit_）に流し、
 * 結果を「自己テスト」シートに ○ / × / 未実施で書く。
 * 「設定」シートの値は使わない（前後で同じかを A06 で比べるだけで、詳細にも書かない）・書かない。設定は初期値（DEFAULT_CONFIG）から作り、DRY_RUN が TRUE のときだけ流す。
 * 「設定」シートがあれば、A02〜A05 は流さない（流すかは、あるかだけで決める）。本番が壊れて「設定」を読んでも、送る先がないようにするため。
 * メールは送らない（宛先は @example.com だけ）。本番の処理を呼ぶ間だけ、MailApp を「送らずに数える」代わりに差し替え、
 * 前後で 1 日に送れる残りの通数も読む（selfTestWithoutMail_。director 2026-10-19）。このファイルが MailApp に触るのはそこだけ。
 *
 * 期待値（受付番号・ログの文・見出し・ステータスの選択肢）は、文字をこのファイルに直接書く。本番の関数（formatDateKey・
 * nextInquiryId・renderTemplate など）や定数（STATUS_OPTIONS など）で作らない。本番の誤りが期待値にも入り、偽の ○ になるため
 * （仕様 4.5、docs/LESSONS.md 2026-10-18）。今日の日付の部分は Utilities.formatDate で別に作る。
 * 自己テスト側の値が本番と同じかは tests/selftest.test.js で確かめる。
 *
 * 上に純粋関数（Node.js から require して単体テストする）、下に GAS の処理。
 * 最上位の var は定数だけにする（コードの指紋に入るため。仕様 8.3）。最上位で他のファイルの名前を使わない。
 * 続き（時間で止まったときの続きから）は入れない。毎回、最初から実施する（仕様 6.5）。
 */

var SELFTEST_VERSION = '2026-10-19';
var SELFTEST_SHEET = '自己テスト';
var SELFTEST_NAME_PREFIX = '自己テスト';
var SELFTEST_HEADERS = ['番号', '区分', '項目', '結果', '詳細', '秒', '回'];
var SELFTEST_COLOR_HEADER = '#e0e0e0';
var SELFTEST_COLOR_INPUT = '#fff8c5';
var SELFTEST_COLOR_RED = '#c62828';
var SELFTEST_NAME_MESSAGE = 'このスプレッドシートの名前が「自己テスト」で始まっていないので、止めました。自己テストは、本番のデータを消さないように、テスト専用のスプレッドシートでだけ動きます。新しいスプレッドシートを作り、名前を「自己テスト_受付」のようにしてから実行してください。';
var SELFTEST_MANUAL_STOP_MESSAGE = '「自己テスト」シートの M01・M02 に書き込みがあるので、止めました。書き込みを別に控えてから、「自己テスト」シートを消して、もう一度押してください。';
var SELFTEST_M03_TEXT = 'ここには書かないでください。確かめたものは、README 9 章の行ごとに、何を見てどうだったかを別に送ってください';
var SELFTEST_NOT_YET = '時間: まだ実施していません';
var SELFTEST_A01_FAILED = '実施できません: DRY_RUN が TRUE でないので止めました';
var SELFTEST_DAY_CHANGED = '時間: 日付が変わったので、もう一度押してください';
// 本番の処理がメールを送った・送ろうとした（ログに「送信しました」、差し替えた送信の関数が呼ばれた、残りの通数が減った）ら、
// 残りの A02〜A05 は流さない（送るメールを増やさない。tester・director 2026-10-19）
var SELFTEST_SENT_HEAD = '送信しました: ';
var SELFTEST_MAIL_SENT = '実施できません: 本番の処理がメールを送った（または送ろうとした）ので、残りは流しませんでした';
// 送信の関数の差し替え（c）と、残りの通数（a）の文。{n}・{before}・{after} は数に置き換える
var SELFTEST_MAIL_CALLED = '本番の処理がメールの送信（MailApp.sendEmail）を {n} 回呼びました（差し替えていたので送っていません）';
var SELFTEST_QUOTA_DROPPED = '本番の処理がメールを送りました（1 日に送れる残りの通数が {before} から {after} に減りました）';
var SELFTEST_NOT_REPLACED = '送信の関数を差し替えられませんでした（送ったかは、1 日に送れる残りの通数とログで見ました）';
// 差し替えも効かず、残りの通数も読めない（送信を見張る手段が 1 つもない）ときは、○ にせず未実施（偽の ○ を出さない。director 2026-10-19）。
// 残りの A02〜A05 も、見張れないまま本番を呼ばないように流さない
var SELFTEST_UNWATCHED = '送信を見張れないので判定しません（送信の関数を差し替えられず、1 日に送れる残りの通数も読めませんでした）';
// 「設定」シートがあれば A02〜A05 は流さない（本番が壊れて「設定」を読んでも、エラーの通知を含めてメールの送り先がないように。director 2026-10-19）
var SELFTEST_CONFIG_EXISTS = '実施できません: このスプレッドシートに「設定」シートがあるので、流しませんでした。「設定」シートを消してから押してください';
// 日付が変わったときも × は残す（版 4 の「違いが 1 つでもあれば ×」。director 2026-10-19）。日付のせいの × かもしれないことを詳細に足す
var SELFTEST_DAY_CHANGED_FAIL = '途中で日付が変わりました。日付のせいの × かもしれないので、もう一度押してください';
// 「設定」があって流さなかったときの全体の詳細（監査 推奨 1）
var SELFTEST_CONFIG_EXISTS_OVERALL = '「設定」シートを消してから、もう一度押してください';

// 本番の処理に渡す入力（5.3）
var SELFTEST_CONFIG_SHEET = '設定';
var SELFTEST_LOG_SHEET = 'ログ';
var SELFTEST_RESPONSE_SHEET = '自己テスト_回答';
var SELFTEST_RESPONSE_HEADERS = ['タイムスタンプ', 'お名前', 'メールアドレス', 'お問い合わせ内容'];
var SELFTEST_NOTIFY_TO = 'notify@example.com';
var SELFTEST_PEOPLE = {
  A02: { row: 2, name: '山田 太郎', email: 'yamada@example.com', body: 'お見積もりの相談です' },
  A03: { row: 3, name: '佐藤 花子', email: 'sato@example.com', body: '資料を送ってください' },
  A05: { row: 4, name: '鈴木 一郎', email: 'not-an-email', body: '電話で連絡がほしいです' },
};

// 期待値（文字で書く。{今日} は自己テストが Utilities.formatDate で作った yyyyMMdd に置き換える。仕様 5.3）
// 本番の COL_ID・COL_STATUS・COL_PROCESSED_AT・STATUS_NEW・STATUS_OPTIONS を使わずに書く（仕様 4.5）
var SELFTEST_MANAGEMENT_HEADERS = ['受付番号', 'ステータス', '処理日時'];
var SELFTEST_STATUS_NEW = '未対応';
var SELFTEST_STATUS_OPTIONS = ['未対応', '対応中', '完了', '対応不要'];
var SELFTEST_IDS = { A02: 'INQ-{今日}-001', A03: 'INQ-{今日}-002', A05: 'INQ-{今日}-003' };
// ログに足される行: [レベル, 内容]
var SELFTEST_LOGS = {
  A02: [
    ['INFO', '[DRY_RUN] 送信予定: yamada@example.com / 【受付番号 INQ-{今日}-001】お問い合わせを受け付けました'],
    ['INFO', '[DRY_RUN] 送信予定: notify@example.com / 【新規受付】INQ-{今日}-001 山田 太郎 様'],
    ['INFO', '受付処理が完了しました（DRY_RUN: メール未送信）'],
  ],
  A03: [
    ['INFO', '[DRY_RUN] 送信予定: sato@example.com / 【受付番号 INQ-{今日}-002】お問い合わせを受け付けました'],
    ['INFO', '[DRY_RUN] 送信予定: notify@example.com / 【新規受付】INQ-{今日}-002 佐藤 花子 様'],
    ['INFO', '受付処理が完了しました（DRY_RUN: メール未送信）'],
  ],
  A04: [
    ['INFO', '行 2 は処理済みのためスキップしました'],
  ],
};
var SELFTEST_A05_WARN = 'メールアドレスが不正なため自動返信を送りませんでした';
var SELFTEST_A05_NOTIFY = '[DRY_RUN] 送信予定: notify@example.com / 【新規受付】INQ-{今日}-003 鈴木 一郎 様';
var SELFTEST_SEND_HEAD = '[DRY_RUN] 送信予定: ';

// 実行の順（5.3）。needs: 前提の項目（○ でなければ流さない）、dated: 日付が変わったら未実施にする項目
var SELFTEST_PLAN = [
  { id: 'A01', kind: '判定', title: '初期値の DRY_RUN が TRUE（DRY_RUN）', run: selfTestA01_ },
  { id: 'A02', kind: '判定', title: '1 件目（山田 太郎）: 受付番号 001・管理列・ステータスの選択肢・ログ。メールは送らない', run: selfTestA02_, needs: 'A01', dated: true },
  { id: 'A03', kind: '判定', title: '2 件目: 受付番号が 002（連番）', run: selfTestA03_, needs: 'A01', dated: true },
  { id: 'A04', kind: '判定', title: '1 件目の行でもう一度呼ぶ: 処理済みとしてスキップ（二重に処理しない）', run: selfTestA04_, needs: 'A01', dated: true },
  { id: 'A05', kind: '判定', title: 'メールアドレスが不正（not-an-email）: 自動返信は送らず、通知だけ', run: selfTestA05_, needs: 'A01', dated: true },
  { id: 'A06', kind: '判定', title: '「設定」シートを変えていない', run: selfTestA06_ },
];

// 手で確認（5.4）
var SELFTEST_MANUAL = [
  { id: 'M01', title: '本番のメニュー（README の手順）: フォームを作り、回答先の「本番確認_受付」に、自己テストと同じ ZIP の main.js・lib.js・appsscript.json だけを貼る。DRY_RUN は TRUE のまま 1 回送信。E 列に (1) メニューの項目 (2) 回答の行に受付番号（INQ- で始まり -001 で終わる）とステータス「未対応」が入ったか (3) 「ログ」に [DRY_RUN] 送信予定 が 2 行あり ERROR がないか (4) Gmail の「送信済み」に example.com 宛てが増えていないか (5) ZIP をダウンロードした日' },
  { id: 'M02', title: '承認画面の文（自己テストのときと M01 のとき）。E 列に書き写すか、スクリーンショットを添える。自分のメールアドレスと名前は書かない' },
  { id: 'M03', title: '任意の手で確認（手順は README 9 章）: DRY_RUN = FALSE で自分宛てに 1 件送り、自動返信と通知が届く／「② 自動実行を有効にする」を 2 回押しても、トリガーが 1 つだけ' },
];

// コードの指紋に入れる名前（8.3）。main.js・lib.js・selftest.js の最上位の関数と var の全部を、名前の順に。
// 手で数えない。tests/selftest.test.js がファイルの中身とちょうど一致するかを確かめる
var SELFTEST_FINGERPRINT_FUNCS = [
  'buildSelfTestValues',
  'codeFingerprint',
  'columnLetter',
  'compareTables',
  'createLogSheet_',
  'ensureManagementColumns_',
  'fingerprintSources',
  'flattenNamedValues',
  'formatAnswers',
  'formatDateKey',
  'formatDiffs',
  'handleFormSubmit_',
  'installTrigger',
  'isValidEmail',
  'issueInquiryId_',
  'itemResult',
  'loadConfig_',
  'missingConfigKeys',
  'nextInquiryId',
  'notifyError_',
  'onFormSubmit',
  'onOpen',
  'overallResult',
  'parseConfig',
  'removeTriggers',
  'renderTemplate',
  'runSelfTest',
  'selfTestA01_',
  'selfTestA02_',
  'selfTestA03_',
  'selfTestA04_',
  'selfTestA05_',
  'selfTestA06_',
  'selfTestCheckId_',
  'selfTestCheckLogs_',
  'selfTestCheckNoError_',
  'selfTestConfig_',
  'selfTestDryRunConfig_',
  'selfTestExpand_',
  'selfTestFinalMessage_',
  'selfTestFinish_',
  'selfTestHasOwn_',
  'selfTestInfoRows_',
  'selfTestItemContext_',
  'selfTestLocked_',
  'selfTestLogAdded_',
  'selfTestLogCount_',
  'selfTestMailGuardText_',
  'selfTestMessage_',
  'selfTestPrepareSheet_',
  'selfTestReason_',
  'selfTestResetResponses_',
  'selfTestResponseRow_',
  'selfTestRunItem_',
  'selfTestSafeText_',
  'selfTestSeconds_',
  'selfTestSheetText_',
  'selfTestSubmit_',
  'selfTestText_',
  'selfTestToday_',
  'selfTestValues_',
  'selfTestWithoutMail_',
  'selfTestWrite_',
  'selfTest_',
  'sendMail_',
  'setup',
  'writeLog_',
];
var SELFTEST_FINGERPRINT_VARS = [
  'COL_ID',
  'COL_PROCESSED_AT',
  'COL_STATUS',
  'DEFAULT_CONFIG',
  'REQUIRED_KEYS',
  'SELFTEST_A01_FAILED',
  'SELFTEST_A05_NOTIFY',
  'SELFTEST_A05_WARN',
  'SELFTEST_COLOR_HEADER',
  'SELFTEST_COLOR_INPUT',
  'SELFTEST_COLOR_RED',
  'SELFTEST_CONFIG_EXISTS',
  'SELFTEST_CONFIG_EXISTS_OVERALL',
  'SELFTEST_CONFIG_SHEET',
  'SELFTEST_DAY_CHANGED',
  'SELFTEST_DAY_CHANGED_FAIL',
  'SELFTEST_FINGERPRINT_FUNCS',
  'SELFTEST_FINGERPRINT_VARS',
  'SELFTEST_HEADERS',
  'SELFTEST_IDS',
  'SELFTEST_LOGS',
  'SELFTEST_LOG_SHEET',
  'SELFTEST_M03_TEXT',
  'SELFTEST_MAIL_CALLED',
  'SELFTEST_MAIL_SENT',
  'SELFTEST_MANAGEMENT_HEADERS',
  'SELFTEST_MANUAL',
  'SELFTEST_MANUAL_STOP_MESSAGE',
  'SELFTEST_NAME_MESSAGE',
  'SELFTEST_NAME_PREFIX',
  'SELFTEST_NOTIFY_TO',
  'SELFTEST_NOT_REPLACED',
  'SELFTEST_NOT_YET',
  'SELFTEST_PEOPLE',
  'SELFTEST_PLAN',
  'SELFTEST_QUOTA_DROPPED',
  'SELFTEST_RESPONSE_HEADERS',
  'SELFTEST_RESPONSE_SHEET',
  'SELFTEST_SEND_HEAD',
  'SELFTEST_SENT_HEAD',
  'SELFTEST_SHEET',
  'SELFTEST_STATUS_NEW',
  'SELFTEST_STATUS_OPTIONS',
  'SELFTEST_UNWATCHED',
  'SELFTEST_VERSION',
  'SHEET_CONFIG',
  'SHEET_LOG',
  'STATUS_NEW',
  'STATUS_OPTIONS',
];

// ==================== 純粋関数 ====================

function selfTestHasOwn_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 1 → A、26 → Z、27 → AA */
function columnLetter(n) {
  var s = '';
  var x = n;
  while (x > 0) {
    var m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/**
 * 2 次元の文字の配列を比べる（A06 で使う）。options: { name（diffs のセルの前に付ける） }
 * 戻り値: { expectedCount（期待値のセルの数）, compared（比べたセルの数）, diffs: [{ cell, expected, actual }] }
 */
function compareTables(expected, actual, options) {
  var opts = options || {};
  var prefix = opts.name ? opts.name + ' ' : '';
  var exp = expected || [];
  var act = actual || [];
  var expectedCount = 0;
  exp.forEach(function (row) { expectedCount += row.length; });
  var diffs = [];
  var compared = 0;
  if (exp.length !== act.length) diffs.push({ cell: prefix + '行の数', expected: String(exp.length), actual: String(act.length) });
  var rows = Math.min(exp.length, act.length);
  for (var i = 0; i < rows; i++) {
    var e = exp[i];
    var a = act[i];
    if (e.length !== a.length) diffs.push({ cell: prefix + (i + 1) + ' 行目の列の数', expected: String(e.length), actual: String(a.length) });
    var cols = Math.min(e.length, a.length);
    for (var j = 0; j < cols; j++) {
      compared++;
      if (String(a[j]) === String(e[j])) continue;
      diffs.push({ cell: prefix + columnLetter(j + 1) + (i + 1), expected: String(e[j]), actual: String(a[j]) });
    }
  }
  return { expectedCount: expectedCount, compared: compared, diffs: diffs };
}

/**
 * 詳細の文。3 か所まで並べ、残りは「ほか n か所」。1 か所は 120 文字まで。
 * diffs: [{ cell, expected, actual }] か [{ text }]
 */
function formatDiffs(diffs, limit) {
  var max = limit || 3;
  var oneLine = function (v) { return String(v).replace(/\r\n|\r|\n/g, '\\n'); };
  var shown = diffs.slice(0, max).map(function (d) {
    var s = d.text !== undefined ? oneLine(d.text) : d.cell + ': 期待「' + oneLine(d.expected) + '」実際「' + oneLine(d.actual) + '」';
    return s.length > 120 ? s.slice(0, 119) + '…' : s;
  });
  var text = shown.join('。');
  if (diffs.length > max) text += '。ほか ' + (diffs.length - max) + ' か所';
  return text;
}

/**
 * 項目の結果（5 章の冒頭）。checks: [{ name, ok, detail?, count?（既定 1。表は比べたセルの数）, diffs? }]
 * ○ は「確かめるはずの数 > 0」かつ「確かめた数 = 確かめるはずの数」かつ「違いが 0」のときだけ。
 * 戻り値: { result: '○' | '×' | '未実施', detail }
 */
function itemResult(expectedCount, checks) {
  var checked = 0;
  var failures = [];
  (checks || []).forEach(function (c) {
    checked += c.count === undefined ? 1 : c.count;
    if (c.ok) return;
    if (c.diffs && c.diffs.length > 0) c.diffs.forEach(function (d) { failures.push(d); });
    else failures.push({ text: c.detail ? c.detail : c.name });
  });
  var head = '確かめた ' + checked + ' / ' + expectedCount;
  if (checked > expectedCount) {
    return { result: '×', detail: '自己テストのコードの誤り: ' + head + (failures.length > 0 ? '。' + formatDiffs(failures, 3) : '') };
  }
  if (failures.length > 0) return { result: '×', detail: head + '。' + formatDiffs(failures, 3) };
  if (expectedCount <= 0) return { result: '未実施', detail: '実施できません: 確かめる数が 0 です' };
  if (checked < expectedCount) return { result: '未実施', detail: '実施できません: ' + head };
  return { result: '○', detail: head };
}

/** 未実施の理由: 'time'（時間が足りない・日付が変わった・実行中）か 'other' */
function selfTestReason_(item) {
  if (item.result === '実行中') return 'time';
  return String(item.detail || '').indexOf('時間:') === 0 ? 'time' : 'other';
}

/**
 * 全体の判定（6.1 の 6）。plan: 判定の項目の番号の一覧、results: { 番号: { result, detail } }（判定の項目だけ）
 * 受付には続きがないので、時間による未実施の文は「最初から実施します」にする（6.5）。
 * 戻り値: { result: 'すべて合格' | '不合格' | '未完了', detail }
 */
function overallResult(plan, results) {
  var list = plan || [];
  var res = results || {};
  var planned = {};
  list.forEach(function (id) { planned[id] = true; });
  var errors = [];
  if (list.length === 0) errors.push('判定の項目がありません');
  Object.keys(res).forEach(function (id) { if (!selfTestHasOwn_(planned, id)) errors.push('予定にない番号の結果があります: ' + id); });
  var missing = list.filter(function (id) { return !selfTestHasOwn_(res, id) || !res[id]; });
  if (missing.length > 0) errors.push('結果のない番号があります: ' + missing.join('、'));
  if (errors.length > 0) return { result: '不合格', detail: '自己テストのコードの誤り: ' + errors.join('。') };

  var unknown = list.filter(function (id) { return ['○', '×', '未実施', '実行中'].indexOf(res[id].result) === -1; });
  if (unknown.length > 0) return { result: '不合格', detail: '自己テストのコードの誤り: 結果の値が違います: ' + unknown.join('、') };
  var failed = list.filter(function (id) { return res[id].result === '×'; });
  var pending = list.filter(function (id) { return res[id].result === '未実施' || res[id].result === '実行中'; });
  var timePending = pending.filter(function (id) { return selfTestReason_(res[id]) === 'time'; });
  var otherPending = pending.length - timePending.length;
  if (failed.length > 0) {
    var text = '× が ' + failed.length + ' 件（番号: ' + failed.join('、') + '）';
    if (timePending.length > 0) text += '。未実施 ' + timePending.length + ' 件は、もう一度押すと最初から実施します';
    return { result: '不合格', detail: text };
  }
  if (pending.length > 0) {
    if (otherPending === 0) return { result: '未完了', detail: '未実施 ' + pending.length + ' 件。もう一度「自己テスト（開発用）」を押すと最初から実施します' };
    if (pending.some(function (id) { return res[id].detail === SELFTEST_CONFIG_EXISTS; })) {
      return { result: '未完了', detail: '未実施 ' + pending.length + ' 件。' + SELFTEST_CONFIG_EXISTS_OVERALL };
    }
    // 例は、最初の押し直しても実施できない項目の詳細から取る（再監査 推奨 2）
    var firstOther = pending.filter(function (id) { return selfTestReason_(res[id]) === 'other'; })[0];
    var example = String(res[firstOther].detail || '').replace(/^実施できません: /, '');
    return { result: '未完了', detail: '未実施 ' + pending.length + ' 件のうち ' + otherPending + ' 件は、押し直しても実施できません（例: ' + firstOther + ' は「' + example + '」）。この画面を送ってください' };
  }
  return { result: 'すべて合格', detail: '判定 ' + list.length + ' 件がすべて ○（自動の項目だけ）。本番のメニューでの確認（M01）と承認画面の文（M02）は、手で書いてから送ってください' };
}

/**
 * 最後の画面の文（7 章）。「未完了」のときは M01・M02 をまだ書かない（書くと押し直しで止まるため。6.5）。
 * dayChanged: 途中で日付が変わり、× を残したまま終わった（監査 推奨 2）。押し直すので、M01・M02 はまだ書かない
 */
function selfTestFinalMessage_(overall, dayChanged) {
  var head = '自己テストの結果: ' + overall.result + '。' + selfTestSafeText_(overall.detail);
  if (overall.result === '未完了') return head + '\nM01・M02 はまだ書かないでください。';
  if (dayChanged) return head + '\nM01・M02 はまだ書かずに、もう一度押してください。';
  return head + '\nM01・M02 を書いてから「自己テスト」シートを送ってください。';
}

/** 個人の情報を出さない（4.2）: URL と、example.com 以外のメールアドレスを伏せる */
function selfTestSafeText_(text) {
  return String(text)
    .replace(/https?:\/\/[^\s　「」（）、。]+/g, '（URL は伏せました）')
    .replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g, function (m) { return /@example\.com$/i.test(m) ? m : '（メールアドレスは伏せました）'; });
}

function selfTestSeconds_(v) {
  if (typeof v === 'number') return (Math.round(v * 10) / 10).toFixed(1);
  return v === undefined || v === null ? '' : String(v);
}

/**
 * 「自己テスト」シートの値（4.2）。すべて文字。
 * items: [{ id, kind, title, result, detail, seconds, run }]（1 つ目は全体の行）、
 * manual: [{ id, title, detail }]（M03 の E 列は決まった文）、info: [{ id, title, detail }]
 */
function buildSelfTestValues(items, manual, info) {
  var text = function (v) { return v === undefined || v === null ? '' : selfTestSafeText_(String(v)); };
  var blank = ['', '', '', '', '', '', ''];
  var rows = [SELFTEST_HEADERS.slice()];
  items.forEach(function (it) {
    rows.push([text(it.id), text(it.kind), text(it.title), text(it.result), text(it.detail), selfTestSeconds_(it.seconds), it.run === undefined || it.run === null ? '' : String(it.run)]);
  });
  rows.push(blank.slice());
  manual.forEach(function (m) {
    var detail = m.id === 'M03' ? SELFTEST_M03_TEXT : (m.detail === undefined || m.detail === null ? '' : String(m.detail));
    rows.push([m.id, '手で確認', text(m.title), '手で', detail, '', '']);
  });
  rows.push(blank.slice());
  info.forEach(function (x) { rows.push([x.id, '情報', text(x.title), '', text(x.detail), '', '']); });
  return rows;
}

/**
 * I01〜I05 の行（4.2）。受付は続きがないので、I03 はコードの指紋だけ、I04 は「なし」。
 * I05 は送信の関数を差し替えられたか（再監査 必須 2）。始めは「呼んでいない」で、本番の処理を呼ぶたびに直す
 */
function selfTestInfoRows_(at, version, spreadsheet, code) {
  return [
    { id: 'I01', title: '実行', detail: '1=' + at },
    { id: 'I02', title: '版', detail: 'SELFTEST_VERSION=' + version + ' / スプレッドシート=' + spreadsheet },
    { id: 'I03', title: '定数', detail: 'コード=' + code },
    { id: 'I04', title: 'やり直し', detail: 'なし' },
    { id: 'I05', title: '送信の関数', detail: selfTestMailGuardText_(0, 0) },
  ];
}

/** I05 の文。called: 本番の処理を呼んだ回数、replaced: そのうち差し替えが効いた回数 */
function selfTestMailGuardText_(called, replaced) {
  if (called === 0) return '送信の関数=呼んでいない';
  if (replaced === called) return '送信の関数=差し替えた（' + called + ' 回とも）';
  return '送信の関数=差し替えられない（' + called + ' 回のうち、差し替えられたのは ' + replaced + ' 回）';
}

/** 文字の配列から 8 桁の 16 進の値（FNV-1a の 32 ビット、小文字）。各文字の UTF-16 のコード単位を下位・上位の 2 バイトとして足す */
function codeFingerprint(sources) {
  var h = 0x811c9dc5;
  for (var i = 0; i < sources.length; i++) {
    var s = String(sources[i]) + '\u0000';
    for (var j = 0; j < s.length; j++) {
      var c = s.charCodeAt(j);
      h ^= c & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= c >>> 8;
      h = Math.imul(h, 0x01000193);
    }
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

/**
 * コードの指紋に渡す文字の配列（8.3）。lookup(name) は値を返す関数（GAS ではグローバルから引く）。
 * 戻り値: { sources, ok }。ok が偽（引けない関数・ソースを返さない toString・undefined の var）なら I03 は「コード=取れません」
 */
function fingerprintSources(names, varNames, lookup) {
  var sources = [];
  var ok = true;
  var get = function (name) {
    try { return lookup(name); } catch (e) { return undefined; }
  };
  names.forEach(function (name) {
    var fn = get(name);
    if (typeof fn !== 'function') { ok = false; sources.push('f:' + name + ':?'); return; }
    var text = String(fn.toString());
    if (text.indexOf('function ' + name + '(') === -1) ok = false;
    sources.push('f:' + name + ':' + text);
  });
  varNames.forEach(function (name) {
    var v = get(name);
    if (v === undefined) { ok = false; sources.push('v:' + name + ':?'); return; }
    // SELFTEST_PLAN の run のように値に関数があれば、名前を残す（どの関数を呼ぶかを変えても指紋が変わるように。仕様 8.3 版 4）
    sources.push('v:' + name + ':' + JSON.stringify(v, function (k, x) { return typeof x === 'function' ? 'function ' + x.name : x; }));
  });
  return { sources: sources, ok: ok };
}

/** 期待値の {今日} を、自己テストが作った yyyyMMdd に置き換える */
function selfTestExpand_(template, today) {
  return String(template).split('{今日}').join(today);
}

// ==================== GAS の処理 ====================

/** メニューから実行 */
function runSelfTest() {
  selfTest_();
}

/**
 * 本体。clock: 時刻を返す関数（ミリ秒）。省略時は Date.now。テストから時刻を決めるために渡す。
 * 戻り値（テスト用）: { status, overall? }
 */
function selfTest_(clock) {
  var tick = clock || function () { return Date.now(); };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  if (String(ss.getName()).indexOf(SELFTEST_NAME_PREFIX) !== 0) {
    ui.alert(SELFTEST_NAME_MESSAGE);
    return { status: 'notTestSpreadsheet' };
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) {
    ui.alert('自己テストが実行中です。終わってからもう一度押してください。');
    return { status: 'locked' };
  }
  try {
    return selfTestLocked_(ss, ui, tick);
  } catch (err) {
    console.error(err && err.stack || err);
    ui.alert('自己テストが止まりました（「自己テスト」シートが書けていない可能性があります）: ' + selfTestSafeText_(selfTestMessage_(err)));
    return { status: 'error', message: selfTestMessage_(err) };
  } finally {
    lock.releaseLock();
  }
}

function selfTestMessage_(err) {
  return String(err && err.message || err);
}

/** 今日の日付（yyyyMMdd）。本番の formatDateKey を使わずに作る（仕様 5.3・4.5） */
function selfTestToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
}

function selfTestLocked_(ss, ui, tick) {
  // 1. 前回の「自己テスト」シート（自己テストのものでなければ何も書かずに止める）
  var existing = ss.getSheetByName(SELFTEST_SHEET);
  var previousRows = [];
  if (existing) {
    var lastColumn = existing.getLastColumn();
    var header = lastColumn > 0 ? existing.getRange(1, 1, 1, lastColumn).getValues()[0].map(String) : [];
    if (header.join('\t') !== SELFTEST_HEADERS.join('\t')) {
      ui.alert('「自己テスト」シートが自己テストのものではありません（1 行目の見出しが違います）。「自己テスト」シートの名前を変えてから実行してください。');
      return { status: 'foreignSheet' };
    }
    previousRows = selfTestSheetText_(existing);
  }

  // 2. M01・M02 の書き込み（推奨 6）。受付は毎回作り直すので、書き込みがあれば何も書かずに止める
  var written = previousRows.filter(function (r) {
    return (r[0] === 'M01' || r[0] === 'M02') && String(r[4] === undefined ? '' : r[4]).replace(/[\s　]/g, '') !== '';
  });
  if (written.length > 0) {
    ui.alert(SELFTEST_MANUAL_STOP_MESSAGE);
    return { status: 'manualWritten' };
  }

  // 3. 回の始めに 1 回だけ読む値（I01〜I03、今日の日付）と、「設定」シートの中身（A06 で前後を比べる）
  var start = tick();
  var tz = Session.getScriptTimeZone();
  var nowText = Utilities.formatDate(new Date(start), tz, 'yyyy-MM-dd HH:mm');
  var print = fingerprintSources(SELFTEST_FINGERPRINT_FUNCS, SELFTEST_FINGERPRINT_VARS, function (name) { return globalThis[name]; });
  var configSheet = ss.getSheetByName(SELFTEST_CONFIG_SHEET);
  var ctx = {
    ss: ss,
    clock: tick,
    run: 1,
    today: selfTestToday_(),
    stamp: Utilities.formatDate(new Date(start), tz, 'yyyy/MM/dd HH:mm:ss'),
    info: selfTestInfoRows_(nowText, SELFTEST_VERSION, String(ss.getName()), print.ok ? codeFingerprint(print.sources) : '取れません'),
    results: {},
    manual: SELFTEST_MANUAL.map(function (m) { return { id: m.id, title: m.title, detail: '' }; }),
    state: { configBefore: configSheet ? selfTestSheetText_(configSheet) : null },
    overall: { result: '未完了', detail: '途中で止まりました。もう一度「自己テスト（開発用）」を押すと最初から実施します' },
    sheet: null,
  };
  SELFTEST_PLAN.forEach(function (p) {
    ctx.results[p.id] = { result: '未実施', detail: SELFTEST_NOT_YET, seconds: '', run: 1 };
  });

  // 4. シートを作り直して、全部「未実施」で書く（6.1 の 1）
  ctx.sheet = selfTestPrepareSheet_(ctx);
  selfTestWrite_(ctx);

  // 5. 項目を順に流す（A02〜A05 は同じ回で順に。6.6）
  SELFTEST_PLAN.forEach(function (p) {
    // 「設定」があるかだけを見る（中身は読まない）。項目ごとに見るので、途中でできた場合も止まる
    if (p.needs && ss.getSheetByName(SELFTEST_CONFIG_SHEET)) {
      ctx.results[p.id] = { result: '未実施', detail: SELFTEST_CONFIG_EXISTS, seconds: '', run: ctx.run };
      selfTestWrite_(ctx);
      return;
    }
    if (p.needs && ctx.state.unwatched) {
      ctx.results[p.id] = { result: '未実施', detail: SELFTEST_UNWATCHED, seconds: '', run: ctx.run };
      selfTestWrite_(ctx);
      return;
    }
    if (p.needs && ctx.state.mailSent) {
      ctx.results[p.id] = { result: '未実施', detail: SELFTEST_MAIL_SENT, seconds: '', run: ctx.run };
      selfTestWrite_(ctx);
      return;
    }
    if (p.needs && ctx.results[p.needs].result !== '○') {
      ctx.results[p.id] = { result: '未実施', detail: SELFTEST_A01_FAILED, seconds: '', run: ctx.run };
      selfTestWrite_(ctx);
      return;
    }
    ctx.results[p.id] = { result: '実行中', detail: '', seconds: '', run: ctx.run };
    selfTestWrite_(ctx);
    selfTestRunItem_(ctx, p);
    selfTestWrite_(ctx);
  });

  // 6. 実行の途中で日付が変わったら、受付番号の日付の部分が変わるので、A02〜A05 は未実施（5.3）
  // 変えるのは、まだ × が出ていない項目だけ。すでに出た × は残し、詳細に日付が変わったことを足す（版 4 の「違いが 1 つでもあれば ×」）。
  // 押し直しても変わらない未実施（A01 が ○ でない・メールを送った・「設定」がある）の理由も残す
  var dayChanged = selfTestToday_() !== ctx.today && !ctx.state.mailSent;
  if (dayChanged) {
    SELFTEST_PLAN.forEach(function (p) {
      var r = ctx.results[p.id];
      if (!p.dated || (r.result === '未実施' && selfTestReason_(r) === 'other')) return;
      if (r.result === '×') {
        ctx.results[p.id] = { result: '×', detail: r.detail + '。' + SELFTEST_DAY_CHANGED_FAIL, seconds: r.seconds, run: r.run };
        return;
      }
      ctx.results[p.id] = { result: '未実施', detail: SELFTEST_DAY_CHANGED, seconds: r.seconds, run: ctx.run };
    });
  }

  // 7. 全体の判定
  var plan = SELFTEST_PLAN.filter(function (p) { return p.kind === '判定'; }).map(function (p) { return p.id; });
  var results = {};
  plan.forEach(function (id) { results[id] = ctx.results[id]; });
  ctx.overall = overallResult(plan, results);
  ctx.overallSeconds = (tick() - start) / 1000;
  selfTestWrite_(ctx);
  ctx.sheet.activate();
  ui.alert(selfTestFinalMessage_(ctx.overall, dayChanged));
  return { status: 'done', overall: ctx.overall };
}

/** 1 つの項目を流して結果を入れる。例外は × */
function selfTestRunItem_(ctx, p) {
  var c = selfTestItemContext_(ctx);
  var t0 = ctx.clock();
  var error = null;
  try {
    p.run(c);
  } catch (e) {
    error = e;
    console.error(e && e.stack || e);
  }
  var seconds = (ctx.clock() - t0) / 1000;
  var value = error ? { result: '×', detail: '例外: ' + selfTestMessage_(error) + (c.notRunText ? '。' + c.notRunText : '') } : selfTestFinish_(c);
  // 本番の処理がメールを送った・送ろうとしたら、ほかの確認が全部合っていても ×（ログの文に頼らない。director 2026-10-19）
  if (c.mailFailures.length > 0) value = { result: '×', detail: value.detail + '。' + c.mailFailures.join('。') };
  if (c.mailNotes.length > 0) value = { result: value.result, detail: value.detail + '。' + c.mailNotes.join('。') };
  ctx.results[p.id] = { result: value.result, detail: value.detail, seconds: seconds, run: ctx.run };
}

/** 項目の関数に渡すもの。expect で確かめるはずの数を決め、check で 1 つずつ確かめる（必須 1） */
function selfTestItemContext_(ctx) {
  var c = {
    ss: ctx.ss,
    run: ctx,
    state: ctx.state,
    today: ctx.today,
    expected: 0,
    checks: [],
    notes: [],
    notRunText: null,
    mailFailures: [],
    mailNotes: [],
  };
  c.expect = function (n) { c.expected += n; };
  c.check = function (name, ok, detail) { c.checks.push({ name: name, ok: !!ok, detail: detail }); };
  // 確かめられなかった n 個の条件を、まとめて × として数える
  c.fail = function (name, n, detail) { c.checks.push({ name: name, ok: false, count: n, detail: detail }); };
  c.checkTable = function (name, cmp, diffs) {
    c.checks.push({ name: name, count: cmp.compared, ok: cmp.diffs.length === 0 && cmp.compared === cmp.expectedCount, diffs: diffs || cmp.diffs });
  };
  c.note = function (text) { c.notes.push(text); };
  c.notRun = function (text) { c.notRunText = text; };
  return c;
}

function selfTestFinish_(c) {
  // 違いが 1 つでもあれば、途中で実施できなくなっても ×（5 章の冒頭。未実施で × を隠さない。仕様 版 4）
  if (c.notRunText && c.checks.some(function (x) { return !x.ok; })) {
    var failed = itemResult(c.expected, c.checks);
    return { result: '×', detail: failed.detail + '。' + c.notRunText };
  }
  if (c.notRunText) return { result: '未実施', detail: c.notRunText };
  var r = itemResult(c.expected, c.checks);
  return { result: r.result, detail: c.notes.length > 0 ? r.detail + '。' + c.notes.join('。') : r.detail };
}

// ---- 「自己テスト」シート ----

function selfTestValues_(ctx) {
  var items = [{ id: '0', kind: '全体', title: '全体の判定', result: ctx.overall.result, detail: ctx.overall.detail, seconds: ctx.overallSeconds === undefined ? '' : ctx.overallSeconds, run: ctx.run }];
  SELFTEST_PLAN.forEach(function (p) {
    var r = ctx.results[p.id];
    items.push({ id: p.id, kind: p.kind, title: p.title, result: r.result, detail: r.detail, seconds: r.seconds, run: r.run });
  });
  return buildSelfTestValues(items, ctx.manual, ctx.info);
}

/** シートを作り直す（受付は毎回）。書く範囲を全部 @ にしてから色と幅を付ける（推奨 6） */
function selfTestPrepareSheet_(ctx) {
  var ss = ctx.ss;
  var old = ss.getSheetByName(SELFTEST_SHEET);
  if (old) ss.deleteSheet(old);
  var sheet = ss.insertSheet(SELFTEST_SHEET, 0);
  var values = selfTestValues_(ctx);
  var rows = values.length;
  var cols = SELFTEST_HEADERS.length;
  sheet.getRange(1, 1, rows, cols).setNumberFormat('@');
  sheet.getRange(1, 1, rows, cols).setBackgrounds(values.map(function (row, i) {
    return row.map(function (v, j) {
      if (i === 0) return SELFTEST_COLOR_HEADER;
      return j === 4 && (row[0] === 'M01' || row[0] === 'M02') ? SELFTEST_COLOR_INPUT : '#ffffff';
    });
  }));
  sheet.getRange(1, 1, 1, cols).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(3, 320);
  sheet.setColumnWidth(5, 480);
  sheet.getRange(1, 5, rows, 1).setWrap(true);
  return sheet;
}

/** 値だけを書く（数式は使わない）。× の D 列だけ赤。毎回 flush する（6.1 の 1） */
function selfTestWrite_(ctx) {
  var values = selfTestValues_(ctx);
  var range = ctx.sheet.getRange(1, 1, values.length, SELFTEST_HEADERS.length);
  range.setValues(values);
  range.setFontColors(values.map(function (row, i) {
    return row.map(function (v, j) { return i > 0 && j === 3 && v === '×' ? SELFTEST_COLOR_RED : '#000000'; });
  }));
  SpreadsheetApp.flush();
}

function selfTestSheetText_(sheet) {
  return sheet.getDataRange().getValues().map(function (r) { return r.map(function (v) { return v === null || v === undefined ? '' : String(v); }); });
}

// ---- 受付の準備と実行 ----

/** 初期値（DEFAULT_CONFIG の [キー, 値]）に NOTIFY_TO を足した設定（5.3）。項目ごとに新しく作る */
function selfTestConfig_() {
  var config = parseConfig(DEFAULT_CONFIG.map(function (r) { return [r[0], r[1]]; }));
  config.NOTIFY_TO = SELFTEST_NOTIFY_TO;
  return config;
}

/** DRY_RUN が TRUE でなければ c.notRun して null（6.2） */
function selfTestDryRunConfig_(c) {
  var config = selfTestConfig_();
  if (config.DRY_RUN !== true) {
    c.notRun(SELFTEST_A01_FAILED);
    return null;
  }
  return config;
}

/** 「自己テスト_回答」を見出しだけで作り直す。「ログ」はなければ本番と同じ形で作る（消さない。行を足すだけ） */
function selfTestResetResponses_(ss) {
  var old = ss.getSheetByName(SELFTEST_RESPONSE_SHEET);
  if (old) ss.deleteSheet(old);
  var sheet = ss.insertSheet(SELFTEST_RESPONSE_SHEET);
  sheet.getRange(1, 1, 1, SELFTEST_RESPONSE_HEADERS.length).setValues([SELFTEST_RESPONSE_HEADERS.slice()]);
  if (!ss.getSheetByName(SELFTEST_LOG_SHEET)) createLogSheet_(ss);
  return sheet;
}

function selfTestLogCount_(ss) {
  var sheet = ss.getSheetByName(SELFTEST_LOG_SHEET);
  return sheet ? sheet.getLastRow() : 0;
}

/** 「ログ」に足された行（文字。[日時, レベル, 受付番号, 内容]） */
function selfTestLogAdded_(ss, before) {
  var sheet = ss.getSheetByName(SELFTEST_LOG_SHEET);
  if (!sheet) return [];
  return selfTestSheetText_(sheet).slice(before).filter(function (r) { return r.some(function (v) { return v !== ''; }); });
}

/**
 * 回答の行を書き（write が偽なら書かない）、送信イベントを作って handleFormSubmit_ を呼ぶ。戻り値: ログに足された行。
 * DRY_RUN が TRUE でない設定では呼ばない（二重の守り。6.2）
 */
function selfTestSubmit_(c, config, person, write) {
  if (!config || config.DRY_RUN !== true) throw new Error('DRY_RUN が TRUE でないので、受付の処理を呼びませんでした');
  var sheet = c.ss.getSheetByName(SELFTEST_RESPONSE_SHEET);
  if (!sheet) throw new Error('「' + SELFTEST_RESPONSE_SHEET + '」シートがありません');
  var values = [c.run.stamp, person.name, person.email, person.body];
  var range = sheet.getRange(person.row, 1, 1, values.length);
  if (write) range.setValues([values]);
  var named = {};
  SELFTEST_RESPONSE_HEADERS.forEach(function (h, i) { named[h] = [values[i]]; });
  var before = selfTestLogCount_(c.ss);
  var mail = selfTestWithoutMail_(function () {
    handleFormSubmit_({ range: range, namedValues: named, values: values }, config);
  });
  // I05 に出す、差し替えた回数（再監査 必須 2）
  var guard = c.state.mailGuard || (c.state.mailGuard = { called: 0, replaced: 0 });
  guard.called++;
  if (mail.replaced) guard.replaced++;
  c.run.info[4].detail = selfTestMailGuardText_(guard.called, guard.replaced);
  var added = selfTestLogAdded_(c.ss, before);
  if (added.some(function (r) { return String(r[3]).indexOf(SELFTEST_SENT_HEAD) === 0; })) c.state.mailSent = true;
  if (mail.calls > 0) {
    c.state.mailSent = true;
    c.mailFailures.push(SELFTEST_MAIL_CALLED.split('{n}').join(String(mail.calls)));
  }
  if (typeof mail.before === 'number' && typeof mail.after === 'number' && mail.after < mail.before) {
    c.state.mailSent = true;
    c.mailFailures.push(SELFTEST_QUOTA_DROPPED.split('{before}').join(String(mail.before)).split('{after}').join(String(mail.after)));
  }
  if (!mail.replaced) {
    if (typeof mail.before === 'number' && typeof mail.after === 'number') {
      c.mailNotes.push(SELFTEST_NOT_REPLACED);
    } else {
      // 見張る手段がない: 違いがあれば ×（selfTestFinish_）、なければ未実施。○ にはしない
      c.state.unwatched = true;
      c.notRun(SELFTEST_UNWATCHED);
    }
  }
  // 本番の例外が外まで出たときも、上の判定（mailSent・unwatched・失敗の文）を済ませてから投げ直す（再監査 必須 1）
  if (mail.error) throw mail.error.value;
  return added;
}

/**
 * fn（本番の処理を呼ぶ関数）を呼ぶ間だけ、MailApp を「送らずに数える」代わりに差し替える（director 2026-10-19 の (c)）。
 * 代わりの sendEmail は送らずに数えるだけ。getRemainingDailyQuota は本物に回す（MailApp の関数はこの 2 つ）。
 * 呼び終わったら必ず元に戻す（finally）。差し替えが効いたかは MailApp === 代わり で見る（呼ぶ前と呼んだあとの両方）。
 * 前後で本物の MailApp の残りの通数も読む（(a)。差し替えが効かないときの頼り。すぐ減るかは Google で未確認）。
 * GAS の V8 で MailApp を差し替えられるかは未確認（README 9 章）。
 * fn の例外は受け止めて error に入れて返す（見張りの結果を捨てないため。呼んだ側が判定を済ませてから投げ直す。再監査 必須 1）。
 * 戻り値: { calls（代わりの sendEmail が呼ばれた回数）, replaced（差し替えが効いたか）, before, after（残りの通数。読めなければ null）,
 *   error（fn の例外を { value } で。なければ null） }
 */
function selfTestWithoutMail_(fn) {
  var real = typeof MailApp === 'undefined' ? undefined : MailApp;
  var quota = function () {
    try {
      var n = real.getRemainingDailyQuota();
      return typeof n === 'number' && !isNaN(n) ? n : null;
    } catch (e) {
      return null;
    }
  };
  var calls = 0;
  var fake = {
    sendEmail: function () { calls++; },
    getRemainingDailyQuota: function () { return real.getRemainingDailyQuota(); },
  };
  var before = quota();
  var replaced = false;
  var error = null;
  try {
    try { globalThis.MailApp = fake; } catch (e) { /* 代入できない。(a) に頼る */ }
    replaced = typeof MailApp !== 'undefined' && MailApp === fake;
    try {
      fn();
    } catch (e) {
      error = { value: e };
    }
    replaced = replaced && MailApp === fake;
  } finally {
    try { globalThis.MailApp = real; } catch (e) { /* 差し替えられなかったときは、そもそも本物のまま */ }
  }
  return { calls: calls, replaced: replaced, before: before, after: quota(), error: error };
}

/** 回答の行の 7 列（見出しの 4 列 ＋ 本番が足す 3 列）。E 列が受付番号、F 列がステータス、G 列が処理日時 */
function selfTestResponseRow_(c, row) {
  return c.ss.getSheetByName(SELFTEST_RESPONSE_SHEET).getRange(row, 1, 1, 7).getValues()[0];
}

function selfTestText_(v) {
  return v === null || v === undefined ? '' : String(v);
}

/** 受付番号（E 列）が期待どおりか */
function selfTestCheckId_(c, row, expectedId, label) {
  var actual = selfTestText_(selfTestResponseRow_(c, row)[4]);
  var expected = selfTestExpand_(expectedId, c.today);
  c.check('受付番号', actual === expected, (label || '') + '回答の E' + row + ' の受付番号: 期待「' + expected + '」実際「' + actual + '」');
}

/** ログの行を 1 行ずつ比べる（行の数が違えば、どの行も ×）。each が偽なら全体を 1 つの確認として数える */
function selfTestCheckLogs_(c, added, expectedRows, each) {
  var expected = expectedRows.map(function (e) { return [e[0], selfTestExpand_(e[1], c.today)]; });
  var countOk = added.length === expected.length;
  var countText = '（足された行 ' + added.length + ' 行。期待 ' + expected.length + ' 行）';
  var lineOk = function (i) {
    var a = added[i];
    return countOk && !!a && a[1] === expected[i][0] && a[3] === expected[i][1];
  };
  var lineText = function (i) {
    var a = added[i];
    return 'ログの ' + (i + 1) + ' 行目: 期待「' + expected[i][0] + ' ' + expected[i][1] + '」実際「' + (a ? a[1] + ' ' + a[3] : 'なし') + '」' + countText;
  };
  if (each) {
    expected.forEach(function (e, i) { c.check('ログ', lineOk(i), lineText(i)); });
    return;
  }
  var bad = -1;
  for (var i = 0; i < expected.length; i++) if (!lineOk(i)) { bad = i; break; }
  c.check('ログ', countOk && bad === -1, bad === -1 ? 'ログ' + countText : lineText(bad));
}

function selfTestCheckNoError_(c, added) {
  var errors = added.filter(function (r) { return r[1] === 'ERROR'; });
  c.check('ログの ERROR', errors.length === 0, 'ログに ERROR があります: ' + (errors.length > 0 ? errors[0][3].split('\n')[0].slice(0, 100) : ''));
}

// ---- 項目（5.3） ----

function selfTestA01_(c) {
  c.expect(1);
  var config = selfTestConfig_();
  c.check('DRY_RUN', config.DRY_RUN === true, '初期値の DRY_RUN が「' + String(config.DRY_RUN) + '」（期待 TRUE）');
}

function selfTestA02_(c) {
  c.expect(3 + 1 + 1 + 1 + 1 + 3 + 1);
  var config = selfTestDryRunConfig_(c);
  if (!config) return;
  var sheet = selfTestResetResponses_(c.ss);
  var p = SELFTEST_PEOPLE.A02;
  var added = selfTestSubmit_(c, config, p, true);

  var header = sheet.getRange(1, 1, 1, 7).getValues()[0].map(selfTestText_);
  SELFTEST_MANAGEMENT_HEADERS.forEach(function (h, i) {
    var col = 5 + i;
    c.check('見出し', header[col - 1] === h, '回答の ' + columnLetter(col) + '1 の見出し: 期待「' + h + '」実際「' + header[col - 1] + '」');
  });
  selfTestCheckId_(c, p.row, SELFTEST_IDS.A02);
  var row = selfTestResponseRow_(c, p.row);
  c.check('ステータス', selfTestText_(row[5]) === SELFTEST_STATUS_NEW, '回答の F' + p.row + ' のステータス: 期待「' + SELFTEST_STATUS_NEW + '」実際「' + selfTestText_(row[5]) + '」');
  var rule = sheet.getRange(p.row, 6).getDataValidation();
  var criteria = rule ? rule.getCriteriaValues() : null;
  var options = criteria && criteria[0] && typeof criteria[0].join === 'function' ? criteria[0].map(selfTestText_) : null;
  c.check('入力規則', !!options && options.join('\t') === SELFTEST_STATUS_OPTIONS.join('\t'),
    '回答の F' + p.row + ' の入力規則: 期待「' + SELFTEST_STATUS_OPTIONS.join('・') + '」実際「' + (options ? options.join('・') : rule ? '選択肢を読めません' : 'なし') + '」');
  var at = row[6];
  var isDate = !!at && typeof at === 'object' && typeof at.getTime === 'function' && !isNaN(at.getTime());
  c.check('処理日時', isDate, '回答の G' + p.row + ' の処理日時が日付ではありません（実際「' + selfTestText_(at) + '」）');
  selfTestCheckLogs_(c, added, SELFTEST_LOGS.A02, true);
  selfTestCheckNoError_(c, added);
}

function selfTestA03_(c) {
  c.expect(1 + 2);
  var config = selfTestDryRunConfig_(c);
  if (!config) return;
  var p = SELFTEST_PEOPLE.A03;
  var added = selfTestSubmit_(c, config, p, true);
  selfTestCheckId_(c, p.row, SELFTEST_IDS.A03);
  selfTestCheckLogs_(c, added, SELFTEST_LOGS.A03, false);
  selfTestCheckNoError_(c, added);
}

/** A04: A02 の行（2 行目）で、書き直さずにもう一度呼ぶ（6.6） */
function selfTestA04_(c) {
  c.expect(3);
  var config = selfTestDryRunConfig_(c);
  if (!config) return;
  var p = SELFTEST_PEOPLE.A02;
  var added = selfTestSubmit_(c, config, p, false);
  selfTestCheckId_(c, p.row, SELFTEST_IDS.A02, 'もう一度呼んだあと: ');
  selfTestCheckLogs_(c, added, SELFTEST_LOGS.A04, false);
  var sends = added.filter(function (r) { return r[3].indexOf(SELFTEST_SEND_HEAD) === 0; });
  c.check('送信予定なし', sends.length === 0, '処理済みの行なのに、送信予定の行が ' + sends.length + ' 行足されました');
}

function selfTestA05_(c) {
  c.expect(1 + 3);
  var config = selfTestDryRunConfig_(c);
  if (!config) return;
  var p = SELFTEST_PEOPLE.A05;
  var added = selfTestSubmit_(c, config, p, true);
  selfTestCheckId_(c, p.row, SELFTEST_IDS.A05);
  var warns = added.filter(function (r) { return r[1] === 'WARN' && r[3].indexOf(SELFTEST_A05_WARN) === 0; });
  c.check('WARN', warns.length === 1, 'WARN の「' + SELFTEST_A05_WARN + '」で始まる行が ' + warns.length + ' 行（期待 1 行）');
  var notify = selfTestExpand_(SELFTEST_A05_NOTIFY, c.today);
  var sends = added.filter(function (r) { return r[3].indexOf(SELFTEST_SEND_HEAD) === 0; });
  c.check('通知だけ', sends.length === 1 && sends[0][1] === 'INFO' && sends[0][3] === notify,
    '送信予定の行が ' + sends.length + ' 行（期待は INFO の「' + notify + '」の 1 行）' + (sends.length > 0 ? '。1 行目「' + sends[0][3] + '」' : ''));
  selfTestCheckNoError_(c, added);
}

/** A06: 自己テストの前後で「設定」シートが同じ。なければ、ないままか（推奨 8）。値は詳細に書かない */
function selfTestA06_(c) {
  var before = c.state.configBefore;
  var sheet = c.ss.getSheetByName(SELFTEST_CONFIG_SHEET);
  if (before === null) {
    c.expect(1);
    c.check('「設定」なし', !sheet, '「設定」がなかったのに、自己テストのあとにあります');
    c.note('「設定」なし。ないままかだけを確認');
    return;
  }
  var cells = 0;
  before.forEach(function (r) { cells += r.length; });
  c.expect(cells);
  if (!sheet) {
    c.fail('「設定」', cells, '「設定」シートが消えました');
    return;
  }
  var cmp = compareTables(before, selfTestSheetText_(sheet), { name: '設定' });
  c.checkTable('設定', cmp, cmp.diffs.map(function (d) { return { text: d.cell + ' が変わりました' }; }));
}

if (typeof module !== 'undefined') {
  module.exports = {
    SELFTEST_VERSION: SELFTEST_VERSION,
    SELFTEST_HEADERS: SELFTEST_HEADERS,
    SELFTEST_M03_TEXT: SELFTEST_M03_TEXT,
    SELFTEST_PLAN: SELFTEST_PLAN,
    SELFTEST_MANUAL: SELFTEST_MANUAL,
    SELFTEST_PEOPLE: SELFTEST_PEOPLE,
    SELFTEST_IDS: SELFTEST_IDS,
    SELFTEST_LOGS: SELFTEST_LOGS,
    SELFTEST_A05_WARN: SELFTEST_A05_WARN,
    SELFTEST_A05_NOTIFY: SELFTEST_A05_NOTIFY,
    SELFTEST_SENT_HEAD: SELFTEST_SENT_HEAD,
    SELFTEST_MAIL_SENT: SELFTEST_MAIL_SENT,
    SELFTEST_CONFIG_EXISTS: SELFTEST_CONFIG_EXISTS,
    SELFTEST_CONFIG_EXISTS_OVERALL: SELFTEST_CONFIG_EXISTS_OVERALL,
    SELFTEST_MAIL_CALLED: SELFTEST_MAIL_CALLED,
    SELFTEST_QUOTA_DROPPED: SELFTEST_QUOTA_DROPPED,
    SELFTEST_NOT_REPLACED: SELFTEST_NOT_REPLACED,
    SELFTEST_UNWATCHED: SELFTEST_UNWATCHED,
    SELFTEST_DAY_CHANGED_FAIL: SELFTEST_DAY_CHANGED_FAIL,
    SELFTEST_MANAGEMENT_HEADERS: SELFTEST_MANAGEMENT_HEADERS,
    SELFTEST_STATUS_NEW: SELFTEST_STATUS_NEW,
    SELFTEST_STATUS_OPTIONS: SELFTEST_STATUS_OPTIONS,
    SELFTEST_FINGERPRINT_FUNCS: SELFTEST_FINGERPRINT_FUNCS,
    SELFTEST_FINGERPRINT_VARS: SELFTEST_FINGERPRINT_VARS,
    columnLetter: columnLetter,
    compareTables: compareTables,
    formatDiffs: formatDiffs,
    itemResult: itemResult,
    overallResult: overallResult,
    buildSelfTestValues: buildSelfTestValues,
    codeFingerprint: codeFingerprint,
    fingerprintSources: fingerprintSources,
    selfTestInfoRows_: selfTestInfoRows_,
    selfTestMailGuardText_: selfTestMailGuardText_,
    selfTestSafeText_: selfTestSafeText_,
    selfTestFinalMessage_: selfTestFinalMessage_,
    selfTestExpand_: selfTestExpand_,
  };
}
