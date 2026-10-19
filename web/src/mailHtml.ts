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
    // width/height on cells and images are layout, not a risk, and dropping
    // them both breaks tables and hides deliberate spacers from the cleanup.
    ADD_ATTR: ['target', 'width', 'height', 'align', 'valign', 'bgcolor', 'cellpadding', 'cellspacing'],
  });
}

export interface PrepareOptions {
  showImages: boolean;
  /** cid -> url, so inline images resolve through the attachment endpoint. */
  inlineImages?: Map<string, string>;
  /** Opening text of earlier messages in the thread, for quote detection. */
  earlierMessages?: string[];
}

/** Normalises text for comparison: case, spacing and punctuation vary on quote. */
function fingerprint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);
}

export function prepareHtml(html: string, showImagesOrOptions: boolean | PrepareOptions): PreparedHtml {
  const opts: PrepareOptions =
    typeof showImagesOrOptions === 'boolean' ? { showImages: showImagesOrOptions } : showImagesOrOptions;
  const showImages = opts.showImages;
  const doc = new DOMParser().parseFromString(sanitize(html), 'text/html');

  // Inline images referenced by Content-ID are never fetchable here.
  for (const img of [...doc.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('cid:')) {
      // Resolve through the attachment endpoint when the part is known;
      // otherwise drop it and release the space it was holding.
      const cid = src.slice(4).replace(/^<|>$/g, '');
      const url = opts.inlineImages?.get(cid);
      if (url) {
        img.setAttribute('src', url);
      } else {
        const cell = img.parentElement;
        img.remove();
        releaseReservedSpace(cell);
      }
    }
  }

  // Tracking pixels are not images anyone asked to see. Offering to load one
  // reads as a broken button — the notice disappears and nothing appears —
  // and taking the offer pings the sender's tracker. Drop them outright.
  for (const img of [...doc.querySelectorAll('img')]) {
    if (isTrackingPixel(img)) {
      const cell = img.parentElement;
      img.remove();
      releaseReservedSpace(cell);
    }
  }

  if (!showImages) {
    for (const img of [...doc.querySelectorAll('img')]) {
      const src = img.getAttribute('src') ?? '';
      if (/^https?:/i.test(src)) {
        img.removeAttribute('src');
        img.setAttribute('data-blocked', '1');
        // Without this the image keeps the space it was designed to fill,
        // so a signature becomes a screen of empty boxes. The cell holding it
        // reserves a column too, which pushes the rest of the table right.
        clearDimensions(img);
        clearAncestorDimensions(img);
      }
    }
  }

  normaliseFontSizes(doc.body);

  dropEmptyCells(doc.body);

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

  // The strongest signal is the thread itself: if a block repeats the opening
  // of an earlier message, it is quoted, whatever divider the client used.
  for (const earlier of opts.earlierMessages ?? []) {
    const needle = fingerprint(earlier);
    if (needle.length < 40) continue;
    const match = [...doc.body.querySelectorAll('p, div, td, blockquote')].find((el) => {
      if (el.querySelector('p, div, td, blockquote')) return false;
      return fingerprint(el.textContent ?? '').startsWith(needle.slice(0, 40));
    });
    if (match) candidates.push(match);
  }

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

  // A forward is nothing but the message it carries, so the boundary sits at
  // the very top and folding everything behind it leaves a blank body. Keep a
  // copy to fall back to.
  const beforeFold = doc.body.cloneNode(true) as HTMLElement;

  if (earliest) {
    // Take the boundary and everything after it, at every level up to the
    // body. Only following siblings: an ancestor still holds the message
    // written above the boundary, which must stay visible.
    //
    // The climb has to pass through a level that has no next sibling rather
    // than stop at it. Outlook wraps its "From:" header in a bare <div> of
    // its own, so the first level up is always a dead end -- treating that
    // as the end of the quote left the whole previous message on screen,
    // below the signature, reading as part of the reply.
    quotedParts.push(earliest.outerHTML);
    const boundary: Element = earliest;
    let node: Element | null = boundary;
    while (node && node !== doc.body) {
      let sibling: Element | null = node.nextElementSibling;
      while (sibling) {
        const next: Element | null = sibling.nextElementSibling;
        quotedParts.push(sibling.outerHTML);
        sibling.remove();
        sibling = next;
      }
      node = node.parentElement;
    }
    boundary.remove();
  }

  collapseBlankSpace(doc.body);

  // Nothing left to read means the boundary was the top of the message, not a
  // divider inside it. Showing the mail beats showing an empty panel.
  if (!hasContent(doc.body)) {
    collapseBlankSpace(beforeFold);
    return {
      visible: beforeFold.innerHTML.trim(),
      quoted: '',
      blockedImages: beforeFold.querySelectorAll('img[data-blocked]').length,
    };
  }

  // Counted after the split, not before: an image held back inside quoted
  // history is not on screen, so offering to load it points at nothing.
  const blockedImages = doc.body.querySelectorAll('img[data-blocked]').length;

  return {
    visible: doc.body.innerHTML.trim(),
    quoted: quotedParts.join(''),
    blockedImages,
  };
}

/** Whether anything would actually render: text, an image or a rule. */
function hasContent(root: HTMLElement): boolean {
  if ((root.textContent ?? '').replace(/\u00a0/g, ' ').trim() !== '') return true;
  return root.querySelector('img, hr, table, video, picture') != null;
}

/**
 * A 1x1 beacon, or an image whose URL is a known open-tracker. Senders ship
 * these in almost every mail; they carry nothing to look at.
 */
function isTrackingPixel(img: Element): boolean {
  const src = img.getAttribute('src') ?? '';
  if (!/^https?:/i.test(src)) return false;
  if (/\b(wf\/open|open\.aspx|\/track(ing)?\/open|pixel|beacon|\.gif\?.*(uid|eid|mid)=)/i.test(src)) return true;

  const box = (name: string): number | null => {
    const attr = img.getAttribute(name);
    const style = img.getAttribute('style') ?? '';
    const styled = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)\\s*px`, 'i').exec(style);
    const raw = styled?.[1] ?? attr;
    if (raw == null || !/^[\d.]+$/.test(raw.trim())) return null;
    return Number(raw);
  };
  const w = box('width');
  const h = box('height');
  return w != null && h != null && w <= 3 && h <= 3;
}

/**
 * Brings the sender's own font sizes into the app's range.
 *
 * Mail is authored against a 16px default, in whatever unit the sender's
 * client uses — 9pt to 14pt is normal in this corpus — so an untouched body
 * renders at a size unrelated to everything around it, and a different one
 * per sender. Scale each declaration by the same factor the base is scaled
 * by, so relative emphasis inside the message survives while the message as
 * a whole sits at the app's size.
 */
const MAIL_BASE_PX = 13.5;
const BROWSER_BASE_PX = 16;

function normaliseFontSizes(root: HTMLElement): void {
  const scale = MAIL_BASE_PX / BROWSER_BASE_PX;

  for (const el of [...root.querySelectorAll<HTMLElement>('[style*="font-size" i]')]) {
    const style = el.getAttribute('style') ?? '';
    el.setAttribute(
      'style',
      style.replace(/(^|;)(\s*font-size\s*:\s*)([\d.]+)\s*(px|pt)/gi, (whole, lead, prop, value, unit) => {
        const px = unit.toLowerCase() === 'pt' ? Number(value) * (4 / 3) : Number(value);
        // Hidden preheader text is sized to nothing on purpose. Scaling it up
        // would drag a line the sender never meant to show into the message.
        if (!Number.isFinite(px) || px < 6) return whole;
        const next = Math.round(Math.min(Math.max(px * scale, 11.5), 22) * 10) / 10;
        return `${lead}${prop}${next}px`;
      }),
    );
  }

  // <font size="1..7"> is a bucket, not a measurement; the stylesheet's own
  // size is closer than any of them for body copy.
  for (const el of [...root.querySelectorAll('font[size]')]) el.removeAttribute('size');
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
 * column, which is what turns an Outlook signature into a stretched grid
 * pushed away from the left margin.
 *
 * Clearing the width is not enough: the cell still occupies a column. An
 * emptied cell is removed outright, and a row left with no cells goes too.
 */
function releaseReservedSpace(start: Element | null): void {
  let el: Element | null = start;

  // Walk upward: an icon usually sits in a <p> inside a <td>, so removing the
  // paragraph leaves the cell still holding its column. Each level that ends
  // up empty is cleared and dropped, until something with content is reached.
  for (let depth = 0; el && depth < 5; depth += 1) {
    if (!/^(TD|TH|DIV|P|SPAN|TR|TBODY|TABLE)$/.test(el.tagName)) break;
    if ((el.textContent ?? '').replace(/\u00a0/g, ' ').trim() !== '') break;
    // Still displays something of its own.
    if (el.querySelector('img, hr, input, video')) break;

    const parent: Element | null = el.parentElement;
    clearDimensions(el);
    if (el.children.length === 0) el.remove();
    el = parent;
  }
}

/**
 * Clears the width and height of ancestors that exist only to hold one image.
 * A blocked headshot in an Outlook signature otherwise keeps its whole column,
 * pushing the text half of the table away from the left margin.
 */
function clearAncestorDimensions(img: Element): void {
  let el: Element | null = img.parentElement;
  for (let depth = 0; el && depth < 3; depth += 1) {
    if (!/^(TD|TH|DIV|P|SPAN)$/.test(el.tagName)) break;
    if ((el.textContent ?? '').replace(/\u00a0/g, ' ').trim() !== '') break;
    clearDimensions(el);
    el = el.parentElement;
  }
}

/**
 * Removes table cells that hold nothing and reserve nothing.
 *
 * An Outlook signature leaves behind wrappers like <p><span></span></p> once
 * its inline image is stripped. The cell then carries no width of its own, but
 * table auto-layout still hands it a share of the row, which is what pushes
 * the signature away from the left margin.
 *
 * A cell with an explicit width, height or background is left alone: in a
 * designed email those are deliberate spacers.
 */
function dropEmptyCells(root: HTMLElement): void {
  for (const cell of [...root.querySelectorAll('td, th')]) {
    if ((cell.textContent ?? '').replace(/\u00a0/g, ' ').trim() !== '') continue;
    if (cell.querySelector('img, hr, input, video, table')) continue;
    if (cell.hasAttribute('width') || cell.hasAttribute('height')) continue;
    if (/(^|;)\s*(min-|max-)?(width|height|background)/i.test(cell.getAttribute('style') ?? '')) continue;

    const row = cell.parentElement;
    cell.remove();
    if (row && row.tagName === 'TR' && row.children.length === 0) row.remove();
  }
}
