import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));

await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar');
await page.waitForTimeout(2500);

const rows = await page.locator('.row').count();
console.log('inbox rows:', rows);
if (rows === 0) { await browser.close(); process.exit(0); }

await page.locator('.row').first().click();
await page.waitForSelector('.drawer', { timeout: 20000 });
await page.waitForTimeout(3500);

const state = await page.evaluate(() => ({
  collapsed: document.querySelectorAll('.msg-collapsed').length,
  expanded: document.querySelectorAll('.msg').length,
  composerOpen: !!document.querySelector('.composer-card'),
  replyButtons: [...document.querySelectorAll('.msg-head-actions .btn')].map((b) => b.textContent.trim()),
  quotedToggles: document.querySelectorAll('.quoted-toggle').length,
  drawerWidth: Math.round(document.querySelector('.drawer')?.getBoundingClientRect().width ?? 0),
  hasResizeHandle: !!document.querySelector('.drawer-resize'),
}));
console.log(JSON.stringify(state, null, 2));
if (errors.length) console.log('ERRORS:', errors.join(' ;; '));
await page.screenshot({ path: '/tmp/rq-shots/thread.png' });
await browser.close();
