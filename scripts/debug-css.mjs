import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar');
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const el = document.querySelector('.toolbar-search');
  const out = { className: el?.className, tag: el?.tagName, type: el?.getAttribute('type'), matching: [] };
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!rule.selectorText) continue;
      try {
        if (el && el.matches(rule.selectorText) && /background|padding-left|flex/.test(rule.style.cssText)) {
          out.matching.push({ sel: rule.selectorText.slice(0, 70), css: rule.style.cssText.slice(0, 110) });
        }
      } catch {}
    }
  }
  return out;
});
console.log(JSON.stringify(info, null, 2).slice(0, 2200));
await browser.close();
