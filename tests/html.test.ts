import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../src/lib/html.js';

describe('entity decoding', () => {
  it('decodes the entities that actually show up in mail', () => {
    expect(decodeEntities('Eric &lt;eric@ferastyle.com&gt;')).toBe('Eric <eric@ferastyle.com>');
    expect(decodeEntities('a&nbsp;&nbsp;b')).toBe('a  b');
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeEntities('&#39;quoted&#39;')).toBe("'quoted'");
    expect(decodeEntities('&#x2014;')).toBe('—');
  });

  it('leaves an unknown entity alone rather than mangling it', () => {
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;');
  });
});

describe('html to text', () => {
  it('keeps line structure instead of collapsing to one paragraph', () => {
    const html = '<div>Hi Eric,</div><div><br></div><div>Here is a recap:</div><p>Vantage Point will resume.</p>';
    expect(htmlToText(html)).toBe('Hi Eric,\n\nHere is a recap:\n\nVantage Point will resume.');
  });

  it('turns <br> into a newline', () => {
    expect(htmlToText('one<br>two<br/>three')).toBe('one\ntwo\nthree');
  });

  it('drops script and style content', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Visible</p><script>alert(1)</script>')).toBe('Visible');
  });

  it('keeps both the label and the target of a link', () => {
    expect(htmlToText('<a href="https://acme.com/x">our site</a>')).toBe('our site <https://acme.com/x>');
  });

  it('does not duplicate a link whose text is the url', () => {
    expect(htmlToText('<a href="https://acme.com">https://acme.com</a>')).toBe('https://acme.com');
  });

  it('decodes entities inside the markup', () => {
    expect(htmlToText('<p>From: Lonnie &lt;lonnie@vantsoft.com&gt;</p>')).toBe('From: Lonnie <lonnie@vantsoft.com>');
  });

  it('collapses runs of blank lines a mail client would not show', () => {
    expect(htmlToText('<p>a</p><br><br><br><br><p>b</p>')).toBe('a\n\nb');
  });

  it('separates table cells', () => {
    expect(htmlToText('<table><tr><td>SKU</td><td>Qty</td></tr></table>')).toBe('SKU\tQty');
  });

  it('survives an empty or tagless input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('just text')).toBe('just text');
  });

  it('leaves quote markers at the start of a line, so history can be detected', () => {
    const html = '<div>It will not work.</div><div>Begin forwarded message:</div><div>From: Lonnie Tee</div>';
    const text = htmlToText(html);
    expect(text.split('\n').some((l) => /^Begin forwarded message:/.test(l))).toBe(true);
  });
});
