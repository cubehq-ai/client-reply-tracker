// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { prepareHtml } from '../web/src/mailHtml.js';

describe('sanitising', () => {
  it('removes scripts and event handlers', () => {
    const { visible } = prepareHtml('<p onclick="steal()">hi</p><script>steal()</script>', true);
    expect(visible).not.toContain('script');
    expect(visible).not.toContain('onclick');
    expect(visible).toContain('hi');
  });

  it('removes iframes and forms', () => {
    const { visible } = prepareHtml('<iframe src="https://evil.test"></iframe><form><input></form><p>body</p>', true);
    expect(visible).not.toMatch(/iframe|form|input/);
    expect(visible).toContain('body');
  });

  it('keeps inline styling, which is how a mail client renders it', () => {
    const { visible } = prepareHtml('<p style="color:#b00">warning</p>', true);
    expect(visible).toContain('color');
  });

  it('opens links in a new tab without handing over the opener', () => {
    const { visible } = prepareHtml('<a href="https://acme.test">x</a>', true);
    expect(visible).toContain('target="_blank"');
    expect(visible).toContain('noopener');
  });
});

describe('remote images', () => {
  it('holds them back by default and counts them', () => {
    const { visible, blockedImages } = prepareHtml('<img src="https://cdn.test/banner.png">', false);
    expect(blockedImages).toBe(1);
    expect(visible).not.toContain('cdn.test');
    expect(visible).toContain('data-blocked');
  });

  it('shows them once asked', () => {
    const { visible, blockedImages } = prepareHtml('<img src="https://cdn.test/banner.png">', true);
    expect(blockedImages).toBe(0);
    expect(visible).toContain('cdn.test');
  });

  it('drops a tracking pixel instead of offering to load it', () => {
    // Nothing would appear if the reader accepted, and accepting tells the
    // sender the mail was opened.
    const beacon = '<p>hi</p><img src="https://email.otter.ai/wf/open?upn=abc" width="1" height="1">';
    const { visible, blockedImages } = prepareHtml(beacon, false);
    expect(blockedImages).toBe(0);
    expect(visible).not.toContain('otter.ai');
    expect(visible).toContain('hi');
  });

  it('drops a 1x1 beacon styled rather than sized', () => {
    const beacon = '<img src="https://cdn.test/t.png" style="width:1px;height:1px">';
    expect(prepareHtml(beacon, false).blockedImages).toBe(0);
  });

  it('does not offer images that live in quoted history', () => {
    // The notice sits above the visible body; an image folded away behind
    // "Show quoted text" is not on screen for it to point at.
    const html =
      '<p>latest</p><div class="gmail_quote"><img src="https://cdn.test/old.png" width="400" height="300"></div>';
    const { visible, quoted, blockedImages } = prepareHtml(html, false);
    expect(blockedImages).toBe(0);
    expect(visible).toContain('latest');
    expect(quoted).toContain('data-blocked');
  });

  it('drops cid: images, which can never load here', () => {
    const { visible } = prepareHtml('<p>hi</p><img src="cid:image001.png@01DD518E">', true);
    expect(visible).not.toContain('cid:');
    expect(visible).toContain('hi');
  });
});

describe('quoted history', () => {
  it('splits a gmail_quote block out of the body', () => {
    const { visible, quoted } = prepareHtml('<div>my reply</div><div class="gmail_quote">older</div>', true);
    expect(visible).toContain('my reply');
    expect(visible).not.toContain('older');
    expect(quoted).toContain('older');
  });

  it('splits an Outlook From: header block and everything after it', () => {
    const html = '<div>my reply</div><div><b>From:</b> someone@acme.test</div><div>the original</div>';
    const { visible, quoted } = prepareHtml(html, true);
    expect(visible).toContain('my reply');
    expect(visible).not.toContain('the original');
    expect(quoted).toContain('the original');
  });

  it('leaves a message with no quoted part alone', () => {
    const { visible, quoted } = prepareHtml('<p>just this</p>', true);
    expect(visible).toContain('just this');
    expect(quoted).toBe('');
  });

  it('does not treat the word From: inside a sentence as a quote header', () => {
    const { quoted } = prepareHtml('<div>I heard From: nobody about this, so here is the plan and more text</div>', true);
    expect(quoted).toBe('');
  });
});

describe('layout left behind by removed images', () => {
  it('releases the space a cid image was reserving', () => {
    const html = '<table><tr><td width="138" style="width:103.5pt"><img src="cid:icon@1" width="16" height="16"></td><td>Jennifer</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    expect(visible).not.toContain('cid:');
    expect(visible).not.toContain('width="138"');
    expect(visible).not.toMatch(/width:\s*103\.5pt/);
  });

  it('strips the dimensions of a blocked remote image', () => {
    const { visible } = prepareHtml('<img src="https://t.test/p.gif" width="600" height="200" style="width:600px">', false);
    expect(visible).not.toContain('width="600"');
    expect(visible).not.toMatch(/width:\s*600px/);
    expect(visible).toContain('data-blocked');
  });

  it('leaves a cell alone when it still holds text', () => {
    const html = '<table><tr><td width="138"><img src="cid:x@1">Jennifer</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    expect(visible).toContain('width="138"');
    expect(visible).toContain('Jennifer');
  });
});

describe('folding a nested quote header', () => {
  it('keeps the reply that sits above a nested Outlook header', () => {
    const html = [
      '<div class="WordSection1">',
      '<p>Thank you! I have approved these.</p>',
      '<p><b>From:</b> Anishikar Singh</p>',
      '<p>the original message</p>',
      '</div>',
    ].join('');
    const { visible, quoted } = prepareHtml(html, true);
    expect(visible).toContain('Thank you! I have approved these.');
    expect(visible).not.toContain('the original message');
    expect(quoted).toContain('the original message');
  });

  it('folds content that follows the header s container too', () => {
    const html = '<div><p>my reply</p><p>From: someone</p></div><div>trailing quoted block</div>';
    const { visible, quoted } = prepareHtml(html, true);
    expect(visible).toContain('my reply');
    expect(visible).not.toContain('trailing quoted block');
    expect(quoted).toContain('trailing quoted block');
  });

  it('does not fold when there is no header at all', () => {
    const { visible, quoted } = prepareHtml('<div><p>just a message</p></div>', true);
    expect(visible).toContain('just a message');
    expect(quoted).toBe('');
  });
});

describe('signature layout after removing inline images', () => {
  it('removes a cell emptied of its icon so the table closes to the left', () => {
    const html = '<table><tr><td width="138"><img src="cid:icon@1"></td><td>Jennifer Eichenberger</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    const cells = (visible.match(/<td/g) ?? []).length;
    expect(cells).toBe(1);
    expect(visible).toContain('Jennifer Eichenberger');
  });

  it('drops a row left with no cells at all', () => {
    const html = '<table><tr><td><img src="cid:spacer@1"></td></tr><tr><td>Real content</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    expect((visible.match(/<tr/g) ?? []).length).toBe(1);
    expect(visible).toContain('Real content');
  });

  it('keeps a cell that still holds a visible image', () => {
    const html = '<table><tr><td><img src="cid:x@1"><img src="https://x.test/logo.png"></td><td>text</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    expect((visible.match(/<td/g) ?? []).length).toBe(2);
  });

  it('drops a cell left with only a line break, which shows nothing', () => {
    const html = '<table><tr><td><img src="cid:x@1"><br></td><td>text</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    expect((visible.match(/<td/g) ?? []).length).toBe(1);
  });
});

describe('blocked images and reserved columns', () => {
  it('clears the column a blocked image was holding', () => {
    const html = '<table><tr><td width="343" style="width:257pt"><img src="https://x.test/p.png" width="300"></td><td>Jennifer</td></tr></table>';
    const { visible } = prepareHtml(html, false);
    expect(visible).not.toContain('width="343"');
    expect(visible).not.toMatch(/width:\s*257pt/);
    expect(visible).toContain('data-blocked');
  });

  it('leaves the cell alone when it also holds text', () => {
    const html = '<table><tr><td width="343"><img src="https://x.test/p.png">Logo</td></tr></table>';
    const { visible } = prepareHtml(html, false);
    expect(visible).toContain('width="343"');
  });
});

describe('empty table cells', () => {
  it('drops a cell left holding only empty wrappers', () => {
    const html = '<table><tr><td style="padding:0"><p><span></span></p></td><td>Jennifer</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    expect((visible.match(/<td/g) ?? []).length).toBe(1);
    expect(visible).toContain('Jennifer');
  });

  it('keeps a deliberate spacer that reserves width', () => {
    const html = '<table><tr><td style="width:40px"></td><td>x</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    expect((visible.match(/<td/g) ?? []).length).toBe(2);
  });

  it('keeps a cell with a background colour', () => {
    const html = '<table><tr><td style="background:#f00"></td><td>x</td></tr></table>';
    const { visible } = prepareHtml(html, true);
    expect((visible.match(/<td/g) ?? []).length).toBe(2);
  });
});

describe('quoting detected from the thread itself', () => {
  it('folds a block that repeats an earlier message, with no divider present', () => {
    const earlier = 'Hi Jennifer, We have updated the LinkedIn content plan around this campaign on the dashboard.';
    const html = `<div><p>Thank you! I have approved these.</p><p>${earlier}</p></div>`;
    const { visible, quoted } = prepareHtml(html, { showImages: true, earlierMessages: [earlier] });
    expect(visible).toContain('Thank you! I have approved these.');
    expect(visible).not.toContain('LinkedIn content plan');
    expect(quoted).toContain('LinkedIn content plan');
  });

  it('ignores punctuation and case differences introduced by quoting', () => {
    const earlier = 'Could you confirm the delivery schedule for next week?';
    const html = `<div><p>Yes, confirmed.</p><p>COULD YOU CONFIRM THE DELIVERY SCHEDULE FOR NEXT WEEK</p></div>`;
    const { visible, quoted } = prepareHtml(html, { showImages: true, earlierMessages: [earlier] });
    expect(visible).toContain('Yes, confirmed.');
    expect(quoted).toContain('DELIVERY SCHEDULE');
  });

  it('does not fold on a short earlier message that could match by chance', () => {
    const { visible, quoted } = prepareHtml('<div><p>Thanks</p><p>Noted</p></div>', {
      showImages: true, earlierMessages: ['Thanks'],
    });
    expect(visible).toContain('Thanks');
    expect(quoted).toBe('');
  });
});

describe('inline images', () => {
  it('resolves a cid reference to the attachment endpoint', () => {
    const { visible } = prepareHtml('<img src="cid:logo@1">', {
      showImages: true,
      inlineImages: new Map([['logo@1', '/api/attachments/7?inline=true']]),
    });
    expect(visible).toContain('/api/attachments/7?inline=true');
  });

  it('still drops a cid image with no matching attachment', () => {
    const { visible } = prepareHtml('<p>hi</p><img src="cid:missing@1">', { showImages: true });
    expect(visible).not.toContain('cid:');
    expect(visible).toContain('hi');
  });
});

describe('font sizes', () => {
  it('scales the sender\'s points into the app\'s range', () => {
    // 11pt is 14.67px against a browser's 16px default; the mail body renders
    // at 13.5px, so the declaration has to come down by the same factor.
    const { visible } = prepareHtml('<p style="font-size:11.0pt">body</p>', true);
    const size = /font-size:\s*([\d.]+)px/.exec(visible)?.[1];
    expect(Number(size)).toBeCloseTo(12.4, 1);
  });

  it('keeps relative emphasis between sizes', () => {
    const { visible } = prepareHtml('<p style="font-size:24px">big</p><p style="font-size:12px">small</p>', true);
    const sizes = [...visible.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes).toHaveLength(2);
    expect(sizes[0]!).toBeGreaterThan(sizes[1]!);
  });

  it('leaves hidden preheader text at nothing', () => {
    // Sized to vanish on purpose; scaling it up drags a line the sender never
    // meant to show into the message.
    const { visible } = prepareHtml('<div style="font-size:1px">preheader</div><p>body</p>', true);
    expect(visible).toContain('font-size:1px');
  });

  it('drops the <font size> bucket, which is not a measurement', () => {
    const { visible } = prepareHtml('<font size="1">tiny</font>', true);
    expect(visible).not.toContain('size="1"');
    expect(visible).toContain('tiny');
  });
});
