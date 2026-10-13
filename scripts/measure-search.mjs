import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
for (const width of [1680, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
  await page.fill('#email', 'dev@cubehq.ai');
  await page.fill('#password', 'process.env.QA_PASSWORD');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(2200);
  const m = await page.evaluate(() => {
    const s = document.querySelector('.toolbar-search')?.getBoundingClientRect();
    const t = document.querySelector('.toolbar')?.getBoundingClientRect();
    const rows = document.querySelectorAll('.toolbar-filters .multiselect').length;
    return { search: Math.round(s?.width ?? 0), toolbar: Math.round(t?.width ?? 0), toolbarH: Math.round(t?.height ?? 0), filters: rows };
  });
  console.log(`viewport ${width}: search ${m.search}px of toolbar ${m.toolbar}px, toolbar height ${m.toolbarH}, ${m.filters} filters`);
  if (width === 1680) await page.screenshot({ path: '/tmp/rq-shots/search.png' });
  await page.close();
}
await browser.close();
