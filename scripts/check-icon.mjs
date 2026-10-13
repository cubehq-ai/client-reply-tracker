import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar');
await page.waitForTimeout(2000);
const style = await page.evaluate(() => {
  const el = document.querySelector('.toolbar-search');
  const cs = getComputedStyle(el);
  return {
    backgroundImage: cs.backgroundImage.slice(0, 40),
    paddingLeft: cs.paddingLeft,
    backgroundPosition: cs.backgroundPosition,
    fontSize: cs.fontSize,
  };
});
console.log(JSON.stringify(style, null, 2));
await browser.close();
