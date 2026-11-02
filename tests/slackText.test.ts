import { describe, expect, it } from 'vitest';
import { renderSlackText } from '../src/slack/text.js';

const names = new Map([['U1', 'Priya'], ['U2', 'Dana']]);

describe('slack wire text, rendered for a reader', () => {
  it('resolves mentions, channels and links', () => {
    expect(renderSlackText('<@U1> see <#C9|general> and <https://x.test|the doc>', names))
      .toBe('@Priya see #general and the doc');
  });

  it('falls back to the id when the user is unknown', () => {
    expect(renderSlackText('<@U404> ping', names)).toBe('@U404 ping');
  });

  /**
   * A list preview showed "_Hi Tyler,_ _We're truly sorry..._" -- a client's
   * formatted apology read as if it were full of stray punctuation.
   */
  it('strips mrkdwn emphasis, which belongs to the renderer and not the text', () => {
    expect(renderSlackText('_Hi Tyler,_ *urgent* ~old~ `code`', names)).toBe('Hi Tyler, urgent old code');
  });

  it('leaves an unpaired underscore alone', () => {
    expect(renderSlackText('file_name here', names)).toBe('file_name here');
  });

  it('unescapes the three characters Slack escapes', () => {
    expect(renderSlackText('5 &gt; 3 &amp;&amp; 2 &lt; 4', names)).toBe('5 > 3 && 2 < 4');
  });

  it('renders broadcasts and user groups as a reader sees them', () => {
    expect(renderSlackText('<!here> and <!subteam^S1|@ops>', names)).toBe('@here and @ops');
  });

  it('prefers the fallback Slack embedded over a bare id', () => {
    expect(renderSlackText('<@U_X|dana> ping', names)).toBe('@dana ping');
  });

  it('keeps a bare url, and a mailto', () => {
    expect(renderSlackText('see <https://x.test/a>', names)).toBe('see https://x.test/a');
    expect(renderSlackText('mail <mailto:a@b.test|a@b.test>', names)).toBe('mail a@b.test');
  });

  it('leaves ordinary text alone', () => {
    expect(renderSlackText('can you check the campaign?', names)).toBe('can you check the campaign?');
  });
});
