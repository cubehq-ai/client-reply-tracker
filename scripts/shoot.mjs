import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });

await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar', { timeout: 15000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/rq-shots/inbox.png' });

// Measure what actually ends up where.
const report = await page.evaluate(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.y) };
  };
  const tops = [...document.querySelectorAll('.toolbar-filters select, .toolbar-actions > *')]
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.textContent || el.getAttribute('placeholder') || '').slice(0, 14), top: Math.round(el.getBoundingClientRect().y), h: Math.round(el.getBoundingClientRect().height) }));
  return {
    viewport: window.innerWidth,
    main: r('.main'),
    card: r('.card'),
    toolbar: r('.toolbar'),
    search: r('.toolbar-search'),
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
    navItems: [...document.querySelectorAll('.nav-item')].map((t) => t.textContent.trim()),
    controls: tops,
  };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
