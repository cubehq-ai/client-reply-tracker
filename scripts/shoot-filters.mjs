import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar');
await page.waitForTimeout(2500);

const triggers = await page.$$eval('.multiselect-trigger', (els) => els.map((e) => e.textContent.trim()));
console.log('filter labels:', JSON.stringify(triggers));

const before = await page.locator('.row').count();
await page.locator('.multiselect-trigger', { hasText: 'Priority' }).click();
await page.waitForTimeout(300);
const opts = await page.$$eval('.multiselect-panel .multiselect-option', (els) => els.map((e) => e.textContent.trim()));
console.log('priority options:', JSON.stringify(opts));

// Tick two boxes and confirm both apply.
await page.locator('.multiselect-option', { hasText: 'High' }).click();
await page.waitForTimeout(900);
const afterHigh = await page.locator('.row').count();
await page.locator('.multiselect-option', { hasText: 'Normal' }).click();
await page.waitForTimeout(900);
const afterBoth = await page.locator('.row').count();
const trigger = await page.locator('.multiselect-trigger', { hasText: 'Priority' }).textContent();

console.log(JSON.stringify({ before, afterHigh, afterBoth, trigger: trigger.trim() }));
await page.screenshot({ path: '/tmp/rq-shots/filters.png' });
await browser.close();
