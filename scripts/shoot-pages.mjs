import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });

await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar');

const problems = [];
for (const [label, nav] of [['clients', 'Clients'], ['teams', 'Teams'], ['settings', 'Settings']]) {
  await page.click(`.nav-item:has-text("${nav}")`);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `/tmp/rq-shots/${label}.png`, fullPage: false });

  // Anything overflowing its container, or a control sitting off-baseline.
  const found = await page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) out.push(`horizontal scroll: ${doc.scrollWidth} > ${doc.clientWidth}`);
    for (const el of document.querySelectorAll('.main table, .main .card')) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`overflow in ${el.className}: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    const heights = new Map();
    for (const el of document.querySelectorAll('.toolbar select, .toolbar input, .toolbar .btn')) {
      const h = Math.round(el.getBoundingClientRect().height);
      heights.set(h, (heights.get(h) || 0) + 1);
    }
    if (heights.size > 1) out.push(`mixed control heights: ${[...heights.keys()].join(', ')}`);
    return out;
  });
  problems.push(`${label}: ${found.length ? found.join(' | ') : 'clean'}`);
}
console.log(problems.join('\n'));
await browser.close();
