import { describe, expect, it } from 'vitest';
import { renderSlackText } from '../src/slack/text.js';

const names = new Map([['U0359TLU8HM', 'Priya Nair'], ['C05P', 'general']]);

describe('rendering slack markup', () => {
  it('turns a mention into the name Slack shows', () => {
    expect(renderSlackText('Hi <@U0359TLU8HM> and team,', names)).toBe('Hi @Priya Nair and team,');
  });

  it('falls back to the id when the user is unknown', () => {
    expect(renderSlackText('<@U_UNKNOWN> ping', names)).toBe('@U_UNKNOWN ping');
  });

  it('prefers the fallback Slack embedded over a bare id', () => {
    expect(renderSlackText('<@U_X|dana> ping', names)).toBe('@dana ping');
  });

  it('renders channels, groups and broadcasts', () => {
    expect(renderSlackText('see <#C05P|general>', names)).toBe('see #general');
    expect(renderSlackText('<!here> please look', names)).toBe('@here please look');
    expect(renderSlackText('<!subteam^S01|@ops> up', names)).toBe('@ops up');
  });

  it('keeps a link label, and a bare url', () => {
    expect(renderSlackText('see <https://x.test/a|the doc>', names)).toBe('see the doc');
    expect(renderSlackText('see <https://x.test/a>', names)).toBe('see https://x.test/a');
    expect(renderSlackText('mail <mailto:a@b.test|a@b.test>', names)).toBe('mail a@b.test');
  });

  it('unescapes what Slack escaped', () => {
    expect(renderSlackText('5 &gt; 3 &amp; 2 &lt; 4', names)).toBe('5 > 3 & 2 < 4');
  });

  it('leaves ordinary text alone', () => {
    expect(renderSlackText('can you check the campaign?', names)).toBe('can you check the campaign?');
  });
});
