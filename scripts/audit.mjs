/**
 * Systematic UI audit. Walks every page, tab and panel and reports layout
 * problems that are easy to ship and tedious to notice by eye:
 *
 *   - a column of controls that does not line up
 *   - content overflowing its container, or the page scrolling sideways
 *   - text clipped with no ellipsis
 *   - controls of mixed height sitting on one row
 *   - a table column that is mostly empty
 *   - console errors
 *
 *   QA_EMAIL=... QA_PASSWORD=... node scripts/audit.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE_URL ?? 'http://localhost:8787';
const EMAIL = process.env.QA_EMAIL;
const PASSWORD = process.env.QA_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('set QA_EMAIL and QA_PASSWORD'); process.exit(1); }

const findings = [];
const report = (where, what) => findings.push(`${where}: ${what}`);

/** Runs inside the page: everything here is pure DOM measurement. */
const AUDIT = () => {
  const out = [];
  const round = (n) => Math.round(n);

  // 1. Columns of form controls should line up.
  for (const table of document.querySelectorAll('.main table')) {
    const rows = [...table.querySelectorAll('tbody tr')];
    if (rows.length < 2) continue;
    const columns = Math.max(...rows.map((r) => r.children.length));
    for (let col = 0; col < columns; col += 1) {
      // Direct children only: a delete button nested after variable-length
      // text is meant to follow that text, not line up across rows.
      const controls = rows
        .map((r) => r.children[col]?.querySelector(':scope > select, :scope > input, :scope > .btn, :scope > button'))
        .filter(Boolean);
      if (controls.length < 2) continue;
      const lefts = new Set(controls.map((c) => round(c.getBoundingClientRect().left)));
      const widths = new Set(controls.map((c) => round(c.getBoundingClientRect().width)));
      const header = table.querySelector(`thead th:nth-child(${col + 1})`)?.textContent?.trim() ?? `column ${col + 1}`;
      if (lefts.size > 1) out.push(`"${header}" controls start at ${[...lefts].join('/')}px`);
      // A button labelled with data is meant to vary; a select or input is not.
      const sized = controls.filter((c) => c.tagName === 'SELECT' || c.tagName === 'INPUT');
      const sizedWidths = new Set(sized.map((c) => round(c.getBoundingClientRect().width)));
      if (sizedWidths.size > 1) out.push(`"${header}" inputs have ${sizedWidths.size} different widths`);
    }
  }

  // 2. Nothing should overflow its container.
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    out.push('the page scrolls sideways');
  }
  for (const el of document.querySelectorAll('.main .card, .main table, .drawer-body')) {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible') {
      out.push(`${el.className.split(' ')[0]} overflows by ${el.scrollWidth - el.clientWidth}px`);
    }
  }

  // 3. Clipped text with no ellipsis reads as a rendering fault.
  for (const el of document.querySelectorAll('.main td, .main .row-title, .nav-item')) {
    const cs = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && cs.overflow === 'hidden') {
      out.push(`text clipped without ellipsis: "${(el.textContent || '').trim().slice(0, 30)}"`);
    }
  }

  // 4. Controls sharing a row should share a height.
  for (const bar of document.querySelectorAll('.toolbar, .toolbar-filters, .toolbar-actions, .section-actions')) {
    const heights = new Set(
      [...bar.querySelectorAll('select, input:not([type=checkbox]), .btn, .multiselect-trigger')]
        .map((e) => round(e.getBoundingClientRect().height))
        .filter((h) => h > 0),
    );
    if (heights.size > 1) out.push(`mixed control heights ${[...heights].join('/')} in .${bar.className.split(' ')[0]}`);
  }

  // 5. A column that is almost entirely empty is usually a bug, not a design.
  for (const table of document.querySelectorAll('.main table')) {
    const rows = [...table.querySelectorAll('tbody tr')];
    if (rows.length < 4) continue;
    const headers = [...table.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    const columns = Math.max(...rows.map((r) => r.children.length));
    for (let col = 0; col < columns; col += 1) {
      const cells = rows.map((r) => r.children[col]).filter(Boolean);
      if (cells.length < 4) continue;
      const blank = cells.filter((c) => {
        const t = (c.textContent || '').trim();
        return (t === '' || t === '—') && !c.querySelector('select, input, button, a');
      }).length;
      if (blank === cells.length) out.push(`column "${headers[col] ?? col + 1}" is empty in every row`);
    }
  }

  // 6. A clickable thing should look clickable.
  for (const el of document.querySelectorAll('.msg-head-toggle, .msg-collapsed, .row, .chip, .tab:not(:disabled), .nav-item')) {
    if (getComputedStyle(el).cursor !== 'pointer') {
      out.push(`.${el.className.split(' ')[0]} is clickable but the cursor is ${getComputedStyle(el).cursor}`);
    }
    // Its children must not reset it either.
    for (const child of el.querySelectorAll('span, div, strong')) {
      if (child.closest('.msg-head-actions')) continue;
      if (getComputedStyle(child).cursor === 'auto' || getComputedStyle(child).cursor === 'default') {
        out.push(`a child of .${el.className.split(' ')[0]} resets the cursor to ${getComputedStyle(child).cursor}`);
        break;
      }
    }
  }

  return out;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 140)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar', { timeout: 20000 });
await page.waitForTimeout(2500);

async function audit(label) {
  await page.waitForTimeout(1200);
  for (const problem of await page.evaluate(AUDIT)) report(label, problem);
}

await audit('Inbox (needs reply)');
await page.locator('.state-tabs .tab', { hasText: 'No reply needed' }).click();
await audit('Inbox (no reply needed)');
await page.locator('.state-tabs .tab', { hasText: 'Needs reply' }).click();

for (const nav of ['Clients', 'Teams', 'Settings']) {
  await page.click(`.nav-item:has-text("${nav}")`);
  await audit(nav);
}
for (const tab of ['Mailboxes & teams', 'Clients & domains', 'Matching rules']) {
  await page.click(`.tab:has-text("${tab}")`);
  await audit(`Settings / ${tab}`);
}

// The thread drawer, with a message open.
await page.click('.nav-item:has-text("Inbox")');
await page.waitForTimeout(1500);
if (await page.locator('.row').count()) {
  await page.locator('.row').first().click();
  await page.waitForSelector('.drawer');
  await audit('Thread');
}

if (consoleErrors.length) report('console', consoleErrors.join(' ;; '));

await browser.close();

if (findings.length === 0) {
  console.log('audit clean');
} else {
  console.log(`${findings.length} finding(s):\n`);
  for (const f of findings) console.log(`  - ${f}`);
}
process.exit(findings.length === 0 ? 0 : 1);
