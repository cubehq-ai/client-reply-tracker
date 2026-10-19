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
    if (src.startsWith('cid:')) { img.remove(); continue; }
  }

  let blockedImages = 0;
  if (!showImages) {
    for (const img of [...doc.querySelectorAll('img')]) {
      const src = img.getAttribute('src') ?? '';
      if (/^https?:/i.test(src)) {
        img.removeAttribute('src');
        img.setAttribute('data-blocked', '1');
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
  const quotedParts: string[] = [];
  for (const selector of QUOTE_SELECTORS) {
    for (const node of [...doc.querySelectorAll(selector)]) {
      quotedParts.push(node.outerHTML);
      node.remove();
    }
  }

  // Outlook writes the quote header as a plain block, often with only a
  // border for a divider, so there is no <hr> to key on.
  const headerBlock = [...doc.body.querySelectorAll('div, p, table')].find((el) => {
    const text = (el.textContent ?? '').trim();
    if (!/^(\*?From:\*?|-{3,}\s*Original Message|Begin forwarded message)/i.test(text)) return false;
    // Must be the start of a block, not a mention inside a longer paragraph.
    return text.length < 2000 && el.parentElement === doc.body;
  });
  if (headerBlock) {
    const rest: string[] = [];
    let node: Element | null = headerBlock;
    while (node) {
      const next: Element | null = node.nextElementSibling;
      rest.push(node.outerHTML);
      node.remove();
      node = next;
    }
    quotedParts.push(rest.join(''));
  }

  // An <hr> followed by a From:/Sent: header is Outlook's quote divider.
  for (const hr of [...doc.querySelectorAll('hr')]) {
    const rest: string[] = [];
    let node: Element | null = hr.nextElementSibling;
    while (node) {
      const next: Element | null = node.nextElementSibling;
      rest.push(node.outerHTML);
      node.remove();
      node = next;
    }
    if (rest.join('').match(/\b(From|Sent|To|Subject)\s*:/i)) {
      quotedParts.push(rest.join(''));
      hr.remove();
    } else {
      // Not a quote divider after all; put it back.
      hr.insertAdjacentHTML('afterend', rest.join(''));
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
