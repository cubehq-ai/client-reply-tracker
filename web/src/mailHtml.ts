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
    quoted: dressQuoted(quotedParts.join('')),
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
/** Quoted history is reference material, and reads a step down from the reply. */
const QUOTED_BASE_PX = 12;

function normaliseFontSizes(root: HTMLElement, basePx: number = MAIL_BASE_PX, fromPx: number = BROWSER_BASE_PX): void {
  const scale = basePx / fromPx;

  for (const el of [...root.querySelectorAll<HTMLElement>('[style*="font-size" i]')]) {
    const style = el.getAttribute('style') ?? '';
    el.setAttribute(
      'style',
      style.replace(/(^|;)(\s*font-size\s*:\s*)([\d.]+)\s*(px|pt)/gi, (whole, lead, prop, value, unit) => {
        const px = unit.toLowerCase() === 'pt' ? Number(value) * (4 / 3) : Number(value);
        // Hidden preheader text is sized to nothing on purpose. Scaling it up
        // would drag a line the sender never meant to show into the message.
        if (!Number.isFinite(px) || px < 6) return whole;
        // The band is proportional to the base, so quoted history really is
        // a step down rather than being clamped back up to the body's floor.
        const next = Math.round(Math.min(Math.max(px * scale, basePx * 0.85), basePx * 1.63) * 10) / 10;
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
  //
  // Walk raw siblings, not element siblings: previousElementSibling steps
  // over the text between two breaks, so "Best<br>Anishikar" counted the
  // blank break above "Best" as part of a run and folded a sign-off onto one
  // line. A break only continues a run when nothing but whitespace precedes
  // it.
  for (const br of [...root.querySelectorAll('br')]) {
    let run = 0;
    let node: Node | null = br.previousSibling;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? '').trim() !== '') break;
        node = node.previousSibling;
        continue;
      }
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
        run += 1;
        node = node.previousSibling;
        continue;
      }
      break;
    }
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

/**
 * Makes quoted history read as history.
 *
 * Folded out of the body it still arrives as full-dress mail: Outlook's
 * five-line From/Sent/To/Cc/Subject block, a gateway's external-sender
 * warning, and font sizes matching the reply above it, so the panel reads as
 * a second message rather than as the thread behind one.
 */
function dressQuoted(html: string): string {
  if (!html.trim()) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');

  collapseQuoteHeader(doc.body);
  dropExternalSenderWarning(doc.body);
  // Measured against the body base, not the browser's: these declarations
  // have already been through the first pass, and scaling them from 16px
  // again would shrink them twice.
  normaliseFontSizes(doc.body, QUOTED_BASE_PX, MAIL_BASE_PX);
  collapseBlankSpace(doc.body);

  return doc.body.innerHTML.trim();
}

/**
 * Replaces Outlook's header block with the one line Gmail shows. Five labelled
 * rows of addresses is most of a screen before any content, and the addresses
 * are already on the message this history belongs to.
 *
 * Every such block, not just the first: quoted history nests, and a thread
 * five replies deep carries one header per level.
 */
function collapseQuoteHeader(root: HTMLElement): void {
  // <font> and <span> are in the list because Outlook puts the whole block
  // inside one; the nested-block test ignores blank children, because the
  // same markup ends with an empty <div>&nbsp;</div> spacer that would
  // otherwise disqualify the wrapper holding the header.
  for (const el of [...root.querySelectorAll('p, div, td, font, span')]) {
    const nested = [...el.querySelectorAll('p, div, td')].some(
      (c) => (c.textContent ?? '').replace(/\u00a0/g, ' ').trim() !== '',
    );
    if (nested) continue;
    const text = (el.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^\*?From:/i.test(text) || text.length > 600) continue;
    if (!/\bSubject:/i.test(text)) continue;

    const from = /From:\s*([^;]*?)\s*(?:Sent:|To:|Date:|Subject:|$)/i.exec(text)?.[1]?.trim();
    const sent = /(?:Sent|Date):\s*(.*?)\s*(?:To:|Cc:|Subject:|$)/i.exec(text)?.[1]?.trim();
    if (!from) continue;

    const line = doc_createAttribution(root, sent ? `On ${sent}, ${from} wrote:` : `${from} wrote:`);
    el.replaceWith(line);
  }
}

function doc_createAttribution(root: HTMLElement, text: string): HTMLElement {
  const line = root.ownerDocument.createElement('div');
  line.className = 'quoted-attr';
  line.textContent = text;
  return line;
}

/**
 * Drops the banner a mail gateway staples to anything from outside the org.
 * It is advice about a message the reader has already opened, and inside
 * quoted history it is the loudest thing on screen.
 */
function dropExternalSenderWarning(root: HTMLElement): void {
  const PATTERN = /(originated from outside|external (e-?mail|sender)|do not click links or open attachments)/i;
  const textOf = (el: Element): string => (el.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  // Every element, not a list of block tags: gateways wrap the sentence in
  // whatever they like -- <b> inside a <div> is common -- and a scan that
  // only knew block tags skipped the wrapper (its child held the text) and
  // never reached the child.
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    const own = textOf(el);
    if (own.length > 400 || !PATTERN.test(own)) continue;
    // Innermost match: the element that actually holds the sentence.
    if ([...el.children].some((c) => PATTERN.test(textOf(c)))) continue;

    // Climb to the outermost wrapper holding nothing but the banner, so the
    // bordered box around it goes too, but a parent carrying real content
    // alongside is left alone.
    let host: Element = el;
    while (host.parentElement && host.parentElement !== root && textOf(host.parentElement) === own) {
      host = host.parentElement;
    }
    const parent = host.parentElement;
    host.remove();
    pruneEmptyAncestors(parent, root);
  }
}

/**
 * Removes wrappers left holding nothing. A gateway banner sits in a bordered
 * box of its own, and taking only the text out leaves the border behind as an
 * empty rectangle.
 */
function pruneEmptyAncestors(from: Element | null, root: HTMLElement): void {
  let node = from;
  while (node && node !== root && !hasContent(node as HTMLElement)) {
    const parent: Element | null = node.parentElement;
    node.remove();
    node = parent;
  }
}
