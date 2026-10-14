import { describe, expect, it } from 'vitest';
import { domainsFromClientDoc, hostFrom } from '../src/sync/internalSync.js';

describe('hostFrom', () => {
  it('reads a Search Console site_url', () => {
    expect(hostFrom('https://amouage.com/')).toBe('amouage.com');
    expect(hostFrom('sc-domain:norbot.ca')).toBe('norbot.ca');
  });

  it('strips the suffix GA4 and GMC names carry', () => {
    expect(hostFrom('www.thinoptics.com - GA4')).toBe('thinoptics.com');
    expect(hostFrom('morelabs.com')).toBe('morelabs.com');
  });

  it('drops www so it matches a sender address', () => {
    expect(hostFrom('https://www.stagprovisions.com')).toBe('stagprovisions.com');
  });

  it('refuses anything that is not a domain', () => {
    expect(hostFrom('Wordpress')).toBeNull();
    expect(hostFrom('someone@acme.com')).toBeNull();
    expect(hostFrom('')).toBeNull();
    expect(hostFrom(null)).toBeNull();
    expect(hostFrom(42)).toBeNull();
  });
});

describe('domainsFromClientDoc', () => {
  it('collects every connected property, deduplicated', () => {
    const doc = {
      _id: 'x',
      seo: { gsc: { site_url: 'https://acme.com/' }, ga4: { name: 'www.acme.com - GA4' }, gmc: { name: 'shop.acme.com' } },
      website_access_id: 'https://acme.com',
    };
    expect(domainsFromClientDoc(doc as any).sort()).toEqual(['acme.com', 'shop.acme.com']);
  });

  it('returns nothing for a client with no connected property', () => {
    expect(domainsFromClientDoc({ _id: 'x', name: 'Norbot', website_access_id: 'Wordpress' } as any)).toEqual([]);
  });
});
