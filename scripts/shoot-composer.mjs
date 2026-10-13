import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar');
await page.waitForTimeout(2500);
await page.locator('.row').first().click();
await page.waitForSelector('.drawer');
await page.waitForTimeout(3000);
await page.locator('.msg-head-actions .btn', { hasText: 'Reply all' }).first().click()
  .catch(() => page.locator('.drawer-foot .btn', { hasText: 'Reply' }).first().click());
await page.waitForSelector('.composer-card', { timeout: 10000 });
await page.waitForTimeout(600);
await page.locator('.field-add').click().catch(() => {});
await page.waitForTimeout(400);
const labels = await page.evaluate(() =>
  [...document.querySelectorAll('.field-row')].map((r) => ({
    label: r.querySelector('.field-label')?.textContent,
    value: (r.querySelector('input,select')?.value ?? '').slice(0, 48),
  })));
console.log(JSON.stringify(labels, null, 2));
await page.screenshot({ path: '/tmp/rq-shots/composer.png' });
await browser.close();
