/**
 * Browser QA. Drives the real app, asserts layout invariants that are easy to
 * break silently, and writes screenshots for review.
 *
 * Credentials come from the environment; never hardcode a login here.
 *   QA_EMAIL=... QA_PASSWORD=... node scripts/qa.mjs
 *
 * Read-only by default. QA_SLACK_WRITE=true additionally exercises "Mark
 * answered", which changes real data in whatever database QA_BASE_URL is
 * pointed at.
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
    // Measure each toolbar CONTROL, not the pieces inside a grouped one: the
    // waiting filter is a single pill, and its select sits inside the pill's
    // border, so it is legitimately 2px shorter. A control nested in a group
    // is excluded; the group itself is measured.
    const controls = [...document.querySelectorAll(
      '.toolbar select, .toolbar input, .toolbar .btn, .multiselect-trigger, .toolbar .wait-filter',
    )].filter((el) => !el.closest('.wait-filter') || el.classList.contains('wait-filter'));
    const heights = new Set(controls.map((el) => Math.round(el.getBoundingClientRect().height)));
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
note(inbox.filters.join(',') === 'Client,Team,Recipient', `filters are ${inbox.filters.join(', ')}`);
note(inbox.searchWidth > 400, `search field is ${inbox.searchWidth}px wide`);
note(!inbox.tabs.some((t) => /whatsapp/i.test(t)), 'no WhatsApp tab');
note(inbox.stateTabs.join(',') === 'Needs reply,No reply needed,All', `state tabs are ${inbox.stateTabs.join(', ')}`);
// "All" is the union of the other two, never a third, larger set.
const counts = await page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('.state-tabs .tab')].map((t) => [
    t.textContent.replace(/\d+$/, '').trim(), Number(t.querySelector('.tab-n')?.textContent ?? 0)])));
note(counts.All === counts['Needs reply'] + counts['No reply needed'],
  `All (${counts.All}) is Needs reply (${counts['Needs reply']}) + No reply needed (${counts['No reply needed']})`);
// Low confidence is Slack-only: on mail the rules-based classifier sets it so
// widely that it narrows nothing.
const mailChips = await page.evaluate(() => [...document.querySelectorAll('.chips button')].map((c) => c.textContent));
note(!mailChips.some((c) => /low confidence/i.test(c)), 'no Low confidence chip on the mail tab');

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

console.log('\nSlack');
// The Slack tab is a channel list, not a mail list: a face, the channel, the
// oldest unanswered message, and how long it has been sitting there.
await page.click('.nav-item:has-text("Inbox")');
await page.waitForTimeout(1200);
const slackReady = await page.locator('.tabs .tab:has-text("Slack")').isEnabled();
if (!slackReady) {
  note(true, 'Slack tab reads "not connected" (no SLACK_USER_TOKEN)');
} else {
  await page.click('.tabs .tab:has-text("Slack")');
  await page.waitForTimeout(2500);
  await layoutChecks('slack');

  const list = await page.evaluate(() => ({
    rows: document.querySelectorAll('.row.slack-row').length,
    mailRows: document.querySelectorAll('.row:not(.slack-row)').length,
    filters: [...document.querySelectorAll('.multiselect-trigger')].map((e) => e.textContent.replace(/\d+$/, '').trim()),
    // Raw mrkdwn in a preview is the bug this tab shipped with: "_Hi Tyler,_".
    rawMarkup: [...document.querySelectorAll('.slack-row-text')]
      .map((e) => e.textContent ?? '').filter((t) => /<@U|<#C|<http|```/.test(t)).length,
    channels: [...document.querySelectorAll('.slack-row-channel')].map((e) => e.textContent),
  }));
  note(list.rows > 0, `slack tab lists ${list.rows} channels`);
  note(list.mailRows === 0, 'no mail-shaped rows on the Slack tab');
  note(list.rawMarkup === 0, `${list.rawMarkup} previews still showing raw Slack markup`);
  note(list.channels.every((c) => c.startsWith('#')), 'every row names its channel');
  note(!list.filters.includes('Recipient'), `slack filters are ${list.filters.join(', ')}`);

  if (list.rows > 0) {
    await page.locator('.row.slack-row').first().click();
    await page.waitForSelector('.slack-drawer', { timeout: 20000 });
    await page.waitForTimeout(2500);
    const conv = await page.evaluate(() => {
      const bodies = [...document.querySelectorAll('.slack-msg-body')].map((e) => e.textContent ?? '');
      return {
        messages: document.querySelectorAll('.slack-msg').length,
        avatars: document.querySelectorAll('.slack-avatar').length,
        days: document.querySelectorAll('.slack-day').length,
        pending: document.querySelectorAll('.slack-msg.pending').length,
        rawMarkup: bodies.filter((t) => /<@U[A-Z0-9]|<#C[A-Z0-9]|<https?:/.test(t)).length,
        strayEmphasis: bodies.filter((t) => /(^|\s)[_*~][A-Za-z]/.test(t)).length,
        headers: document.querySelectorAll('.slack-msg-head').length,
        overflow: [...document.querySelectorAll('.slack-msg')]
          .filter((e) => e.scrollWidth > e.clientWidth + 1).length,
      };
    });
    note(conv.messages > 0, `conversation shows ${conv.messages} messages`);
    note(conv.avatars > 0, 'messages carry an avatar');
    note(conv.days > 0, 'days are separated');
    note(conv.rawMarkup === 0, `${conv.rawMarkup} messages showing raw mention or link markup`);
    note(conv.strayEmphasis === 0, `${conv.strayEmphasis} messages showing stray _ or * emphasis`);
    // Grouping: consecutive messages from one person share a header, so
    // there must be no more headers than messages.
    note(conv.headers <= conv.messages, `${conv.headers} headers for ${conv.messages} messages`);
    note(conv.overflow === 0, 'no message overflows the drawer');
    await page.screenshot({ path: `${OUT}/slack-conversation.png` });

    // Marking one message answered writes to the database this QA run is
    // pointed at, which is usually production. Off unless asked for; the
    // behaviour itself is covered by tests/slackIngest.test.ts.
    if (conv.pending > 0 && process.env.QA_SLACK_WRITE === 'true') {
      const before = await page.locator('.slack-msg.pending').count();
      await page.locator('.slack-answer-btn').first().click({ force: true });
      await page.waitForTimeout(2500);
      const after = await page.locator('.slack-msg.pending').count();
      note(after === before - 1, `mark answered: ${before} waiting -> ${after}`);
    } else if (conv.pending > 0) {
      const enabled = await page.locator('.slack-answer-btn').first().isEnabled();
      note(enabled, 'each waiting message offers Mark answered (QA_SLACK_WRITE=true to exercise it)');
    }
    await page.locator('.drawer-head .btn', { hasText: 'Close' }).click();
    await page.waitForTimeout(600);
  }
  await page.click('.tabs .tab:has-text("Email")');
  await page.waitForTimeout(1500);
}

for (const [label, nav] of [['clients', 'Clients'], ['teams', 'Teams'], ['settings', 'Settings']]) {
  console.log(`\n${nav}`);
  await page.click(`.nav-item:has-text("${nav}")`);
  await page.waitForTimeout(1800);
  await layoutChecks(label);
}

console.log('\nSettings tabs');
// Matching rules was removed from Settings; the rule engine still runs, it
// just has no editor.
for (const tab of ['Mailboxes & teams', 'Clients & domains', 'Slack channels']) {
  await page.click(`.tab:has-text("${tab}")`);
  await page.waitForTimeout(1500);
  const cards = await page.locator('.main .card').count();
  note(cards > 0, `${tab} renders (${cards} cards)`);
}

// Clients has its own search and filters now: the list runs past a hundred.
await page.click('.nav-item:has-text("Clients")');
await page.waitForTimeout(1800);
const clientRows = await page.locator('tbody tr').count();
await page.fill('input.toolbar-search', 'zzzz-no-such-client');
await page.waitForTimeout(600);
const narrowed = await page.locator('tbody tr').count();
note(clientRows > 1 && narrowed < clientRows, `clients search narrows ${clientRows} to ${narrowed}`);
await page.fill('input.toolbar-search', '');
await page.waitForTimeout(500);
note(await page.locator('.toolbar-filters .multiselect-trigger').count() >= 2, 'clients has service and manager filters');

// The deployed app once served the "not built yet" placeholder, which still
// answers 200 — so check what came back, not that something did.
const rootHtml = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 600));
note(!/not built yet/i.test(rootHtml), 'serves the dashboard, not the API placeholder');

note(pageErrors.length === 0, `no console errors${pageErrors.length ? `: ${pageErrors.join(' ;; ')}` : ''}`);

await browser.close();
console.log(`\n${failures.length === 0 ? 'QA passed' : `QA FAILED (${failures.length})`}`);
process.exit(failures.length === 0 ? 0 : 1);
