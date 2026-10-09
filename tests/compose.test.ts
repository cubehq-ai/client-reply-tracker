import { describe, expect, it } from 'vitest';
import { buildMime } from '../src/api/compose.js';

describe('MIME building', () => {
  const base = {
    from: 'priya@cubehq.ai',
    fromName: 'Priya Nair',
    to: ['ops@acme.com'],
    cc: ['rahul@cubehq.ai'],
    subject: 'Re: Q3 invoice discrepancy',
    bodyText: 'Confirmed — reissuing today.',
    inReplyTo: '<acme-1@acme.com>',
    references: ['<acme-0@acme.com>', '<acme-1@acme.com>'],
  };

  it('sets the threading headers Gmail and Outlook need', () => {
    const mime = buildMime(base);
    expect(mime).toContain('In-Reply-To: <acme-1@acme.com>');
    expect(mime).toContain('References: <acme-0@acme.com> <acme-1@acme.com>');
    expect(mime).toContain('Subject: Re: Q3 invoice discrepancy');
  });

  it('sends both a plain-text and an HTML part', () => {
    const mime = buildMime(base);
    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
  });

  it('always carries a Message-ID so the reply can be matched back', () => {
    expect(buildMime(base)).toMatch(/Message-ID: <[^>]+@cubehq\.ai>/);
  });

  it('quotes the previous message in both parts', () => {
    const mime = buildMime({ ...base, quoted: { from: 'ops@acme.com', date: 'Mon, 5 Oct 2026 09:00:00 GMT', body: 'The invoice shows 240 units.' } });
    expect(mime).toContain('> The invoice shows 240 units.');
    expect(mime).toContain('<blockquote');
  });

  it('escapes markup in the HTML part while leaving the text part literal', () => {
    const mime = buildMime({ ...base, bodyText: 'see <script>alert(1)</script>' });
    const htmlPart = mime.slice(mime.indexOf('text/html'));
    expect(htmlPart).toContain('&lt;script&gt;');
    expect(htmlPart).not.toContain('<script>alert(1)</script>');
  });

  it('encodes a non-ASCII subject as an RFC 2047 word', () => {
    const mime = buildMime({ ...base, subject: 'Re: Rückfrage zur Rechnung' });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it('includes Cc only when there is one', () => {
    expect(buildMime(base)).toContain('Cc: rahul@cubehq.ai');
    expect(buildMime({ ...base, cc: [] })).not.toContain('Cc:');
  });
});
