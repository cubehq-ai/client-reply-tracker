import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 420 } });
await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar');
await page.waitForTimeout(2200);
await page.fill('.toolbar-search', 'shopify');
await page.waitForTimeout(1200);
const geom = await page.evaluate(() => {
  const icon = document.querySelector('.search-icon').getBoundingClientRect();
  const input = document.querySelector('.toolbar-search').getBoundingClientRect();
  const clear = document.querySelector('.search-clear')?.getBoundingClientRect();
  const cs = getComputedStyle(document.querySelector('.toolbar-search'));
  return {
    iconRight: Math.round(icon.right), textStartsAt: Math.round(input.left + parseFloat(cs.paddingLeft)),
    clearShown: !!clear, rows: document.querySelectorAll('.row').length,
  };
});
console.log(JSON.stringify(geom));
await page.screenshot({ path: '/tmp/rq-shots/search-bar.png', clip: { x: 232, y: 150, width: 1448, height: 120 } });
await browser.close();
