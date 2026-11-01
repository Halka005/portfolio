/**
 * 請求書テンプレートのプレビューを作る（README 用の画像）。
 * GAS と同じ renderInvoiceHtml を使い、ダミーデータで HTML を出力する。
 *   node scripts/preview.js            → docs/preview.html
 *   node scripts/preview.js --png      → docs/images/invoice-preview.png（Playwright が必要）
 * 注意: 実際の PDF は GAS の変換エンジンで作るため、見た目が多少異なる場合がある。
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../src/lib.js');

const calc = lib.calcInvoice([
  { name: 'Web サイト保守（月額）', quantity: 1, unitPrice: 30000, taxRate: 10 },
  { name: '更新作業', quantity: 3, unitPrice: 5000, taxRate: 10 },
  { name: '打ち合わせ用 茶菓子', quantity: 1, unitPrice: 1080, taxRate: 8 },
]);
const html = lib.renderInvoiceHtml({
  invoiceNumber: 'INV-202610-001',
  issueDate: new Date(2026, 9, 31),
  dueDate: lib.calcDueDate(new Date(2026, 9, 31), '翌月末'),
  calc,
  customer: { name: '株式会社サンプル商事', honorific: '御中', contact: '山田 太郎' },
  issuer: {
    name: 'サンプル事務所',
    address: '〒000-0000 東京都サンプル区1-2-3',
    email: 'billing@example.com',
    registrationNumber: 'T0000000000000',
    bank: 'サンプル銀行 本店 普通 1234567\nサンプルジムショ',
  },
});

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'docs', 'preview.html');
fs.writeFileSync(htmlPath, html);
console.log('wrote', htmlPath);

if (process.argv.includes('--png')) {
  const { chromium } = require('playwright');
  (async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 } }); // A4 @96dpi
    await page.setContent(html);
    const out = path.join(root, 'docs', 'images', 'invoice-preview.png');
    await page.screenshot({ path: out, fullPage: true });
    await browser.close();
    console.log('wrote', out);
  })();
}
