import { Fragment, type ReactNode } from 'react';
import { emojiFor } from './emoji';

/**
 * Slack's mrkdwn, rendered the way Slack renders it.
 *
 * The wire format is not Markdown and is not plain text. `_Hi Tyler,_` is an
 * italic line; shown raw, a client's carefully formatted apology reads as if
 * it were full of stray punctuation, which is how it looked in the first cut.
 * Mentions, channels and links arrive as `<@U123>`, `<#C123|name>` and
 * `<url|label>` -- markup Slack resolves on the client, which is why this
 * runs here, with the user table, rather than on the server.
 */

export interface SlackUserRef { name: string; isInternal: boolean }
export type SlackUsers = Record<string, SlackUserRef>;

/** One rendered message: blocks (paragraph, quote, code, list) in order. */
export function renderSlackMarkdown(text: string, users: SlackUsers): ReactNode {
  return splitCodeBlocks(text).map((part, i) =>
    part.code
      ? <pre key={i} className="slack-code-block">{part.text}</pre>
      : <Fragment key={i}>{renderLines(part.text, users)}</Fragment>);
}

/** Message text with every piece of markup resolved, for a one-line preview. */
export function slackPlainText(text: string, users: SlackUsers): string {
  return text
    .replace(/```([\s\S]*?)```/g, (_m, body: string) => body)
    .replace(/<@([A-Z0-9_]+)(?:\|([^>]*))?>/g, (_m, id: string, fb?: string) => `@${users[id]?.name ?? fb ?? id}`)
    .replace(/<#[A-Z0-9_]+(?:\|([^>]*))?>/g, (_m, name?: string) => `#${name || 'channel'}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_m, name?: string) => `@${name || 'team'}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, k: string) => `@${k}`)
    .replace(/<(?:https?:\/\/|mailto:)([^>|]+)(?:\|([^>]*))?>/g, (_m, url: string, label?: string) => label || url)
    .replace(/[*_~`]/g, '')
    .replace(/:([a-z0-9_+-]+):/gi, (whole, n: string) => emojiFor(n.toLowerCase()) ?? whole)
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Part { code: boolean; text: string }

function splitCodeBlocks(text: string): Part[] {
  const parts: Part[] = [];
  const re = /```([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[1]!.replace(/^\n/, '').replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts.length > 0 ? parts : [{ code: false, text }];
}

/**
 * Line-level structure: blockquotes and bullets, which Slack sends as `>` and
 * a literal `• `. Consecutive quoted lines become one quote, the way they
 * look in Slack, rather than one grey bar per line.
 */
function renderLines(text: string, users: SlackUsers): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let buffer: string[] = [];
  let mode: 'text' | 'quote' | 'list' = 'text';

  const flush = (): void => {
    if (buffer.length === 0) return;
    const body = buffer.join('\n');
    const key = out.length;
    if (mode === 'quote') out.push(<blockquote key={key} className="slack-quote">{inline(body, users)}</blockquote>);
    else if (mode === 'list') {
      out.push(
        <ul key={key} className="slack-list">
          {buffer.map((li, i) => <li key={i}>{inline(li, users)}</li>)}
        </ul>,
      );
    } else out.push(<Fragment key={key}>{inline(body, users)}</Fragment>);
    buffer = [];
  };

  for (const line of lines) {
    const quoted = /^&gt;\s?|^>\s?/.exec(line);
    const bullet = /^\s*[•\-*]\s+/.exec(line);
    const next = quoted ? 'quote' : bullet ? 'list' : 'text';
    if (next !== mode) { flush(); mode = next; }
    buffer.push(quoted ? line.slice(quoted[0].length) : bullet ? line.slice(bullet[0].length) : line);
  }
  flush();
  return out;
}

/** `<...>` entities first -- they can contain anything -- then the emphasis. */
const TOKEN_SOURCE = [
  '<[@#!][^>]*>',                       // mention, channel, broadcast
  '<[^>]+>',                            // link
  '`[^`\\n]+`',                         // inline code
  '\\*[^*\\n]+\\*',                     // bold
  '_[^_\\n]+_',                         // italic
  '~[^~\\n]+~',                         // strike
  ':[a-z0-9_+-]+(?:::skin-tone-\\d+)?:', // emoji shortcode
].join('|');

function inline(text: string, users: SlackUsers): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // A fresh regex per call. Emphasis recurses into this function, and a
  // shared /g regex would have the inner walk reset the outer one's
  // lastIndex -- an infinite loop on the first bold word.
  const token_re = new RegExp(TOKEN_SOURCE, 'gi');

  const push = (node: ReactNode): void => { out.push(<Fragment key={out.length}>{node}</Fragment>); };
  const plain = (s: string): void => { if (s) push(unescape(s)); };

  while ((m = token_re.exec(text)) != null) {
    plain(text.slice(last, m.index));
    push(token(m[0], users));
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
}

function token(raw: string, users: SlackUsers): ReactNode {
  if (raw.startsWith('<@')) {
    const [, id, fallback] = /^<@([A-Z0-9_]+)(?:\|([^>]*))?>$/i.exec(raw) ?? [];
    const user = id ? users[id] : undefined;
    const name = user?.name ?? (fallback || id || 'someone');
    // Our own people read differently from the client's: "did they ask us or
    // each other" is the whole question a channel row answers.
    return <span className={`slack-mention ${user?.isInternal ? 'us' : ''}`}>@{name}</span>;
  }
  if (raw.startsWith('<#')) {
    const [, id, name] = /^<#([A-Z0-9_]+)(?:\|([^>]*))?>$/i.exec(raw) ?? [];
    return <span className="slack-mention channel">#{name || id}</span>;
  }
  if (raw.startsWith('<!subteam')) {
    const [, name] = /\|@?([^>]*)>$/.exec(raw) ?? [];
    return <span className="slack-mention group">@{name || 'team'}</span>;
  }
  if (raw.startsWith('<!')) {
    const [, kind] = /^<!(here|channel|everyone)/i.exec(raw) ?? [];
    return <span className="slack-mention broadcast">@{kind ?? 'channel'}</span>;
  }
  if (raw.startsWith('<')) {
    const [, url, label] = /^<([^>|]+)(?:\|([^>]*))?>$/.exec(raw) ?? [];
    if (!url) return unescape(raw);
    const href = url.startsWith('mailto:') ? url : url;
    return <a href={href} target="_blank" rel="noopener noreferrer">{unescape(label || url.replace(/^mailto:/, ''))}</a>;
  }
  if (raw.startsWith('`')) return <code className="slack-code">{raw.slice(1, -1)}</code>;
  // Emphasis renders its contents, not its characters: a line like
  // "_Please reach out to Neil at <mailto:...|neil@kasa.com>._" is one
  // italic run with a link inside it, and treating the inside as plain text
  // put the raw mailto markup on screen.
  if (raw.startsWith('*')) return <strong>{inline(raw.slice(1, -1), users)}</strong>;
  if (raw.startsWith('_')) return <em>{inline(raw.slice(1, -1), users)}</em>;
  if (raw.startsWith('~')) return <s>{inline(raw.slice(1, -1), users)}</s>;
  if (raw.startsWith(':')) {
    const name = raw.slice(1, -1).toLowerCase();
    const glyph = emojiFor(name);
    // A workspace's own emoji has no Unicode form at all, so it keeps its
    // name -- readable as a word, rather than as colon soup.
    return glyph ?? <span className="slack-custom-emoji" title={raw}>:{name.replace(/::skin-tone-\d+$/, '')}:</span>;
  }
  return unescape(raw);
}

function unescape(s: string): string {
  return s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}
