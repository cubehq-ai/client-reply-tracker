// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderSlackMarkdown, slackPlainText, type SlackUsers } from '../web/src/slackMarkdown';

const users: SlackUsers = {
  U_US: { name: 'Priya', isInternal: true },
  U_THEM: { name: 'Dana', isInternal: false },
  U_THEM2: { name: 'Sam', isInternal: false },
};

const html = (text: string): string => renderToStaticMarkup(renderSlackMarkdown(text, users) as any);
/**
 * What a reader actually sees: the markup put into a DOM and read back as
 * text. React re-escapes `>` and `&` on the way out, so stripping tags with
 * a regex would compare against entities rather than against characters.
 */
const seen = (text: string): string => {
  const el = document.createElement('div');
  el.innerHTML = html(text);
  return el.textContent ?? '';
};

describe('slack mrkdwn in the conversation view', () => {
  it('renders emphasis as emphasis rather than as punctuation', () => {
    expect(html('_Hi Tyler,_')).toContain('<em>Hi Tyler,</em>');
    expect(html('*urgent*')).toContain('<strong>urgent</strong>');
    expect(html('~dropped~')).toContain('<s>dropped</s>');
    expect(seen('_Hi Tyler,_')).toBe('Hi Tyler,');
  });

  /**
   * An italic line containing a mailto put "<mailto:neil@kasa.com|neil@
   * kasa.com>" on screen, because emphasis was treated as plain text inside.
   */
  it('renders markup nested inside emphasis', () => {
    const out = html('_Reach Neil at <mailto:neil@kasa.com|neil@kasa.com>._');
    expect(out).toContain('<em>');
    expect(out).toContain('href="mailto:neil@kasa.com"');
    expect(out).not.toContain('&lt;mailto:');
  });

  it('tells our own people from the client\'s in a mention', () => {
    expect(html('<@U_US> can you look?')).toContain('slack-mention us');
    expect(html('<@U_THEM> can you look?')).toMatch(/class="slack-mention ?"/);
    expect(seen('<@U_THEM> can you look?')).toBe('@Dana can you look?');
  });

  it('keeps an unknown mention readable', () => {
    expect(seen('<@U_NOBODY> ping')).toBe('@U_NOBODY ping');
  });

  it('renders links with their label, and bare links as the url', () => {
    expect(html('<https://x.test|the doc>')).toContain('>the doc</a>');
    expect(html('<https://x.test>')).toContain('>https://x.test</a>');
  });

  it('renders code inline and in blocks', () => {
    expect(html('run `npm test`')).toContain('<code class="slack-code">npm test</code>');
    expect(html('```\nline one\nline two\n```')).toContain('<pre class="slack-code-block">line one\nline two</pre>');
  });

  it('groups consecutive quoted lines into one quote', () => {
    const out = html('&gt; first\n&gt; second');
    expect(out.match(/<blockquote/g)).toHaveLength(1);
    expect(out).toContain('first\nsecond');
  });

  it('renders bullets as a list', () => {
    expect(html('• one\n• two')).toContain('<ul class="slack-list">');
  });

  it('renders known emoji and keeps a custom one as its name', () => {
    expect(seen('nice :tada:')).toBe('nice 🎉');
    expect(seen('shipped :done-2:')).toBe('shipped :done-2:');
  });

  it('renders broadcasts and user groups', () => {
    expect(seen('<!here> heads up')).toBe('@here heads up');
    expect(seen('<!subteam^S1|@ops> please look')).toBe('@ops please look');
  });

  it('unescapes the characters Slack escapes', () => {
    expect(seen('5 &gt; 3 &amp;&amp; 2 &lt; 4')).toContain('5 > 3 && 2 < 4');
  });

  /** A bold word used to restart the shared tokenizer and never terminate. */
  it('terminates on nested and repeated emphasis', () => {
    expect(seen('*a* *b* _c_ ~d~ *<@U_US>*')).toBe('a b c d @Priya');
  });
});

describe('slackPlainText', () => {
  it('flattens a message to one line for a preview', () => {
    expect(slackPlainText('_Hi_ <@U_THEM>\n\nplease see <https://x.test|the doc> :tada:', users))
      .toBe('Hi @Dana please see the doc 🎉');
  });
});
