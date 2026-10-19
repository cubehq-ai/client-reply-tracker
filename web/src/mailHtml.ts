import DOMPurify from 'dompurify';

/**
 * Prepares an email's HTML part for rendering.
 *
 * Two jobs beyond sanitising:
 *  - remote images are held back until the reader asks for them, because
 *    loading one tells the sender the mail was opened and from where;
 *  - quoted history is split off so a reply does not render as the whole
 *    thread, matching what the plain-text path already did.
 */

export interface PreparedHtml {
  visible: string;
  quoted: string;
  /** How many remote images were held back. */
  blockedImages: number;
}

/** Selectors mail clients use to wrap the quoted part of a reply. */
const QUOTE_SELECTORS = [
  '.gmail_quote',
  'blockquote.gmail_quote',
  '#appendonsend',
  '[id^="divRplyFwdMsg"]',
  '.OutlookMessageHeader',
  '.moz-cite-prefix',
  'blockquote[type="cite"]',
];

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base'],
    FORBID_ATTR: ['srcset', 'ping', 'formaction'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target'],
  });
}

export function prepareHtml(html: string, showImages: boolean): PreparedHtml {
  const doc = new DOMParser().parseFromString(sanitize(html), 'text/html');

  // Inline images referenced by Content-ID are never fetchable here.
  for (const img of [...doc.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('cid:')) {
      releaseReservedSpace(img.parentElement);
      img.remove();
    }
  }

  let blockedImages = 0;
  if (!showImages) {
    for (const img of [...doc.querySelectorAll('img')]) {
      const src = img.getAttribute('src') ?? '';
      if (/^https?:/i.test(src)) {
        img.removeAttribute('src');
        img.setAttribute('data-blocked', '1');
        // Without this the image keeps the space it was designed to fill,
        // so a signature becomes a screen of empty boxes.
        clearDimensions(img);
        blockedImages += 1;
      }
    }
  }

  // Links leave the app, and must not hand it the opener.
  for (const a of [...doc.querySelectorAll('a[href]')]) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
  }

  // Split the quoted history out of the body.
  //
  // Mail clients each mark the boundary differently, and a long thread can
  // carry several. Collect every candidate, take the earliest in document
  // order, and fold from there — otherwise a later match leaves earlier
  // quoted messages sitting in the open.
  const candidates: Element[] = [];

  for (const selector of QUOTE_SELECTORS) {
    candidates.push(...doc.body.querySelectorAll(selector));
  }

  const header = [...doc.body.querySelectorAll('p, div, td')].find((el) => {
    const own = (el.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    if (!/^(\*?From:|-{3,}\s*Original Message|Begin forwarded message|On .{0,80} wrote:)/i.test(own)) return false;
    if (own.length > 400) return false;
    return !el.querySelector('p, div, td');
  });
  if (header) candidates.push(header);

  // An <hr> is Outlook's divider, but only when a quote header follows it.
  for (const hr of [...doc.body.querySelectorAll('hr')]) {
    const after = (hr.parentElement?.textContent ?? '');
    if (/\b(From|Sent|To|Subject)\s*:/i.test(after)) candidates.push(hr);
  }

  const quotedParts: string[] = [];
  const earliest = candidates.reduce<Element | null>((best, el) => {
    if (!best) return el;
    // DOCUMENT_POSITION_PRECEDING means el comes before best.
    return best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING ? el : best;
  }, null);

  if (earliest) {
    // Take the node and everything after it, at every level up to the body.
    // Only following siblings: an ancestor still holds the message written
    // above the boundary, which must stay visible.
    let node: Element | null = earliest;
    while (node && node !== doc.body) {
      const parent: Element | null = node.parentElement;
      let sibling: Element | null = node;
      while (sibling) {
        const next: Element | null = sibling.nextElementSibling;
        quotedParts.push(sibling.outerHTML);
        sibling.remove();
        sibling = next;
      }
      node = parent && parent !== doc.body ? parent.nextElementSibling : null;
    }
  }

  collapseBlankSpace(doc.body);

  return {
    visible: doc.body.innerHTML.trim(),
    quoted: quotedParts.join(''),
    blockedImages,
  };
}

/**
 * Outlook pads a message with empty paragraphs and long runs of <br>, which
 * render as a screen of blank space. Collapse any run to a single break.
 */
function collapseBlankSpace(root: HTMLElement): void {
  // querySelectorAll does not match the element itself, so a bare <img> would
  // otherwise read as blank and be deleted.
  const CARRIES_CONTENT = 'img, hr, table, video, picture';
  const isBlank = (el: Element): boolean =>
    (el.textContent ?? '').replace(/\u00a0/g, ' ').trim() === '' &&
    !el.matches(CARRIES_CONTENT) &&
    el.querySelectorAll(CARRIES_CONTENT).length === 0;

  // Empty block elements, anywhere in the tree.
  for (const el of [...root.querySelectorAll('p, div')]) {
    if (!isBlank(el)) continue;
    const prev = el.previousElementSibling;
    if (prev && isBlank(prev)) el.remove();
  }

  // Runs of <br>, which Outlook uses instead of paragraph spacing.
  for (const br of [...root.querySelectorAll('br')]) {
    let run = 0;
    let node: Element | null = br.previousElementSibling;
    while (node && node.tagName === 'BR') { run += 1; node = node.previousElementSibling; }
    if (run >= 1) br.remove();
  }

  // A leading or trailing blank block adds nothing either.
  for (const edge of [root.firstElementChild, root.lastElementChild]) {
    if (edge && isBlank(edge)) edge.remove();
  }
}

/** Drops the fixed width and height an element was given by the sender. */
function clearDimensions(el: Element): void {
  el.removeAttribute('width');
  el.removeAttribute('height');
  const style = el.getAttribute('style');
  if (style) {
    const stripped = style.replace(/(^|;)\s*(min-|max-)?(width|height)\s*:[^;]*/gi, '');
    el.setAttribute('style', stripped.replace(/^;+/, ''));
  }
}

/**
 * A table cell sized for an image it no longer holds leaves a tall empty
 * column, which is what turns an Outlook signature into a stretched grid.
 */
function releaseReservedSpace(cell: Element | null): void {
  let el: Element | null = cell;
  // Walk up while the ancestor exists only to hold that image.
  for (let depth = 0; el && depth < 3; depth += 1) {
    if (!/^(TD|TH|DIV|P|SPAN)$/.test(el.tagName)) break;
    const text = (el.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    if (text !== '') break;
    clearDimensions(el);
    el = el.parentElement;
  }
}
