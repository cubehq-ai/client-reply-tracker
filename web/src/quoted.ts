/**
 * Splits a message body into what the sender actually wrote this time and the
 * quoted history beneath it.
 *
 * Mirrors the server-side cleanBody() in src/pipeline/normalize.ts, but keeps
 * the remainder rather than discarding it, so the UI can hide it behind a
 * toggle instead of making every reply look like the whole thread.
 */

const QUOTE_MARKERS: RegExp[] = [
  /^On .+ wrote:\s*$/i,
  /^Begin forwarded message:/i,
  /^CONFIDENTIALITY NOTICE[: ]/i,
  /^This (e-?mail|message) (and any attachments )?(is|are) (intended|confidential)/i,
  /^Disclaimer[: ]/i,
  /^-{3,}\s*Forwarded message\s*-{3,}/i,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^_{5,}$/,
  /^From:\s.+$/i,
  /^\*?From:\*?\s.+$/i,
  /^Sent from my \w+/i,
  /^Get Outlook for \w+/i,
  /^-{3,}\s*Forwarded message\s*-{3,}$/i,
];

export interface SplitBody {
  /** What was written in this message. */
  visible: string;
  /** Quoted history and trailing signature, or empty when there is none. */
  quoted: string;
}

export function splitQuoted(body: string): SplitBody {
  const lines = (body ?? '').replace(/\r\n/g, '\n').split('\n');

  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (QUOTE_MARKERS.some((re) => re.test(line))) { cut = i; break; }
    // A run of quoted lines also starts the history, but a single stray ">"
    // inside a sentence should not.
    if (line.startsWith('>')) {
      const next = (lines[i + 1] ?? '').trim();
      if (next.startsWith('>') || next === '') { cut = i; break; }
    }
  }

  if (cut === -1) return { visible: body.trim(), quoted: '' };

  return {
    visible: lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    quoted: lines.slice(cut).join('\n').trim(),
  };
}
