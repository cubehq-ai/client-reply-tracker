import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));

await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.fill('#email', 'dev@cubehq.ai');
await page.fill('#password', 'process.env.QA_PASSWORD');
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar');
await page.click('.nav-item:has-text("Settings")');
await page.waitForTimeout(1200);

for (const tab of ['Mailboxes & teams', 'Clients & domains', 'Rules & exclusions', 'Integrations']) {
  errors.length = 0;
  await page.click(`.tab:has-text("${tab}")`).catch((e) => errors.push('click failed: ' + e.message.slice(0, 80)));
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => {
    const active = document.querySelector('.tab.active')?.textContent?.trim();
    const cards = document.querySelectorAll('.main .card').length;
    const body = document.querySelector('.main')?.innerText?.slice(0, 120).replace(/\n/g, ' | ');
    return { active, cards, body };
  });
  console.log(`\n[${tab}] active="${state.active}" cards=${state.cards}`);
  console.log(`   body: ${state.body}`);
  if (errors.length) console.log(`   ERRORS: ${errors.join(' ;; ')}`);
}
await browser.close();
