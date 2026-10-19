/**
 * Browser QA. Drives the real app, asserts layout invariants that are easy to
 * break silently, and writes screenshots for review.
 *
 * Credentials come from the environment; never hardcode a login here.
 *   QA_EMAIL=... QA_PASSWORD=... node scripts/qa.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QA_BASE_URL ?? 'http://localhost:8787';
const EMAIL = process.env.QA_EMAIL;
const PASSWORD = process.env.QA_PASSWORD;
const OUT = process.env.QA_OUT ?? '/tmp/rq-shots';

if (!EMAIL || !PASSWORD) {
  console.error('set QA_EMAIL and QA_PASSWORD');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const failures = [];
const note = (ok, label) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForSelector('.sidebar', { timeout: 20000 });
await page.waitForTimeout(2500);

/** No horizontal overflow, and every control in a toolbar shares one height. */
async function layoutChecks(label) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const heights = new Set(
      [...document.querySelectorAll('.toolbar select, .toolbar input, .toolbar .btn, .multiselect-trigger')]
        .map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    const overflow = [...document.querySelectorAll('.main table, .main .card')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1).length;
    return { hScroll: doc.scrollWidth > doc.clientWidth + 1, heights: [...heights], overflow };
  });
  note(!r.hScroll, `${label}: no horizontal page scroll`);
  note(r.overflow === 0, `${label}: no overflowing cards or tables`);
  note(r.heights.length <= 1, `${label}: consistent control heights ${JSON.stringify(r.heights)}`);
  await page.screenshot({ path: `${OUT}/${label}.png` });
}

console.log('\nInbox');
await layoutChecks('inbox');
const inbox = await page.evaluate(() => ({
  rows: document.querySelectorAll('.row').length,
  filters: [...document.querySelectorAll('.multiselect-trigger')].map((e) => e.textContent.replace(/\d+$/, '').trim()),
  searchWidth: Math.round(document.querySelector('.toolbar-search')?.getBoundingClientRect().width ?? 0),
  tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
  stateTabs: [...document.querySelectorAll('.state-tabs .tab')].map((t) => t.textContent.replace(/\d+$/, '').trim()),
}));
note(inbox.filters.join(',') === 'Client,Team,Recipient,Age', `filters are ${inbox.filters.join(', ')}`);
note(inbox.searchWidth > 400, `search field is ${inbox.searchWidth}px wide`);
note(!inbox.tabs.some((t) => /whatsapp/i.test(t)), 'no WhatsApp tab');
note(inbox.stateTabs.join(',') === 'Needs reply,No reply needed', `state tabs are ${inbox.stateTabs.join(', ')}`);

// The second tab must list its own items and its reason chips.
await page.locator('.state-tabs .tab', { hasText: 'No reply needed' }).click();
await page.waitForTimeout(1800);
const closed = await page.evaluate(() => ({
  rows: document.querySelectorAll('.row').length,
  chips: [...document.querySelectorAll('.chips .chip')].map((c) => c.textContent.replace(/\d+$/, '').trim()),
}));
note(closed.rows > 0, `no-reply-needed tab lists ${closed.rows} items`);
note(['Replied', 'No reply needed', 'Filtered', 'Ignored'].every((r) => closed.chips.includes(r)), `reason chips ${JSON.stringify(closed.chips)}`);
await page.locator('.state-tabs .tab', { hasText: 'Needs reply' }).click();
await page.waitForTimeout(1500);

console.log('\nThread');
if (inbox.rows > 0) {
  await page.locator('.row').first().click();
  await page.waitForSelector('.drawer', { timeout: 20000 });
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => ({
    composerOpen: !!document.querySelector('.composer-card'),
    replyButtons: document.querySelectorAll('.msg-head-actions .btn').length,
    resizable: !!document.querySelector('.drawer-resize'),
    addrLabels: [...document.querySelectorAll('.addr-label')].map((e) => e.textContent),
  }));
  note(!t.composerOpen, 'composer is closed until Reply is pressed');
  note(t.replyButtons > 0, 'each open message has its own actions');
  note(t.resizable, 'drawer has a resize handle');
  note(t.addrLabels.every((l) => ['To', 'Cc', 'Bcc'].includes(l)), `address labels ${JSON.stringify([...new Set(t.addrLabels)])}`);
  await page.screenshot({ path: `${OUT}/thread.png` });

  // Expanding and collapsing use the same gesture, and the header's own
  // buttons must still work rather than toggling the message.
  const counts = () => page.evaluate(() => ({
    expanded: document.querySelectorAll('.msg').length,
    collapsed: document.querySelectorAll('.msg-collapsed').length,
  }));
  const before = await counts();
  await page.locator('.msg-head-toggle').first().click();
  await page.waitForTimeout(400);
  const collapsed = await counts();
  note(collapsed.expanded === before.expanded - 1, 'clicking a message header collapses it');

  await page.locator('.msg-collapsed').last().click();
  await page.waitForTimeout(400);
  const reopened = await counts();
  note(reopened.expanded === before.expanded, 'clicking a collapsed row expands it again');

  await page.locator('.msg-head-actions .btn', { hasText: 'Reply' }).first().click();
  await page.waitForTimeout(600);
  const afterReply = await counts();
  const composerOpen = await page.evaluate(() => !!document.querySelector('.composer-card'));
  note(afterReply.expanded === before.expanded && composerOpen, 'Reply in the header opens the composer without collapsing');
  await page.keyboard.press('Escape');

  // Rendered HTML must not inherit pre-wrap from the plain-text styling, or
  // every newline in the markup becomes a visible line break and the message
  // renders two to three times too tall.
  const spacing = await page.evaluate(() => {
    const el = document.querySelector('.msg-html');
    if (!el) return null;
    const blank = [...el.querySelectorAll('div, p')].find(
      (n) => (n.textContent ?? '').trim() === '' && n.querySelector('br'),
    );
    return {
      whiteSpace: getComputedStyle(el).whiteSpace,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      blankHeight: blank ? Math.round(blank.getBoundingClientRect().height) : null,
    };
  });
  if (spacing) {
    note(!/^pre/.test(spacing.whiteSpace), `html white-space is ${spacing.whiteSpace}`);
    if (spacing.blankHeight !== null) {
      note(
        spacing.blankHeight <= spacing.lineHeight * 1.6,
        `a blank line is ${spacing.blankHeight}px against a ${spacing.lineHeight}px line`,
      );
    }
  }
  await page.locator('.drawer-head .btn', { hasText: 'Close' }).click();
  await page.waitForTimeout(600);
} else {
  note(false, 'inbox has no rows to open');
}

for (const [label, nav] of [['clients', 'Clients'], ['teams', 'Teams'], ['settings', 'Settings']]) {
  console.log(`\n${nav}`);
  await page.click(`.nav-item:has-text("${nav}")`);
  await page.waitForTimeout(1800);
  await layoutChecks(label);
}

console.log('\nSettings tabs');
for (const tab of ['Mailboxes & teams', 'Clients & domains', 'Matching rules']) {
  await page.click(`.tab:has-text("${tab}")`);
  await page.waitForTimeout(1500);
  const cards = await page.locator('.main .card').count();
  note(cards > 0, `${tab} renders (${cards} cards)`);
}

note(pageErrors.length === 0, `no console errors${pageErrors.length ? `: ${pageErrors.join(' ;; ')}` : ''}`);

await browser.close();
console.log(`\n${failures.length === 0 ? 'QA passed' : `QA FAILED (${failures.length})`}`);
process.exit(failures.length === 0 ? 0 : 1);
