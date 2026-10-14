/**
 * Converts an HTML mail part to readable plain text.
 *
 * Mail is full of HTML-only messages. Stripping tags naively collapses the
 * whole message onto one line and leaves entities like &nbsp; visible, which
 * also defeats quoted-history detection, since every marker it looks for
 * anchors to the start of a line.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', middot: '·', trade: '™',
  copy: '©', reg: '®', deg: '°', euro: '€', pound: '£', yen: '¥',
  laquo: '«', raquo: '»', times: '×', divide: '÷', shy: '', zwnj: '', zwj: '',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}

/** Tags that end a line of text. */
const BLOCK_END = /<\/(p|div|tr|li|ul|ol|h[1-6]|blockquote|table|section|article|header|footer|pre)\s*>/gi;
// Only a paragraph opens a blank line. A <div> per line is how mail clients
// write signatures, and treating those as paragraphs double-spaces them.
const BLOCK_START = /<(p|h[1-6]|blockquote)(\s[^>]*)?>/gi;

export function htmlToText(html: string): string {
  if (!html) return '';

  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1\s*>/gi, '')
    // A link whose text differs from its target keeps both, as mail clients do.
    // Angle brackets are added back after tag stripping, or the stripper
    // would treat the url we just inserted as a tag and delete it.
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const clean = label.replace(/<[^>]+>/g, '').trim();
      if (!clean) return href;

      // A mailto: or tel: target repeats what the label already says, and an
      // href whose address the label contains adds nothing either.
      const bare = href
        .replace(/^(mailto:|tel:)/i, '')
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/$/, '')
        .replace(/[?#].*$/, '');
      const normalise = (v: string) => v.toLowerCase().replace(/[^a-z0-9@.]/g, '');
      if (/^(mailto:|tel:)/i.test(href) || normalise(clean).includes(normalise(bare))) return clean;

      return clean === href ? clean : `${clean} \u0001${href}\u0002`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(BLOCK_END, '\n')
    .replace(BLOCK_START, '\n')
    // Table cells read better separated than run together.
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '');

  text = decodeEntities(text)
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>');

  return text
    // Inline-image placeholders are an artefact of the mail client, not content.
    .replace(/\[cid:[^\]]+\]/gi, '')
    .split('\n')
    // Collapse runs of spaces inside a line, but keep the line itself.
    .map((line) => line.replace(/[ \u00a0]+/g, ' ').trimEnd())
    // HTML signatures are often tables, which leave lines holding nothing but
    // a separator once the markup is gone.
    .filter((line, i, all) => {
      const t = line.trim();
      if (t === '' ) return true;
      if (/^[|,;·•\-–—\u2502]+$/.test(t)) return false;
      // A lone comma or pipe trailing a real line is table debris too.
      return !(t.length <= 2 && /^[,|]/.test(t) && (all[i - 1] ?? '').trim() !== '');
    })
    .join('\n')
    // At most one blank line between paragraphs.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}
