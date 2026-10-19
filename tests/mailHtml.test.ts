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
    const { visible, blockedImages } = prepareHtml('<img src="https://tracker.test/pixel.gif">', false);
    expect(blockedImages).toBe(1);
    expect(visible).not.toContain('tracker.test');
    expect(visible).toContain('data-blocked');
  });

  it('shows them once asked', () => {
    const { visible, blockedImages } = prepareHtml('<img src="https://tracker.test/pixel.gif">', true);
    expect(blockedImages).toBe(0);
    expect(visible).toContain('tracker.test');
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
