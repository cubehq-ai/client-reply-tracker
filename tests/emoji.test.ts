// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emojiFor, reactionLabel, renderEmoji } from '../web/src/emoji.js';

describe('slack emoji', () => {
  it('renders a shortcode in message text', () => {
    expect(renderEmoji('Thank you so much! :smiling_face_with_3_hearts:')).toBe('Thank you so much! 🥰');
  });

  it('renders several, and leaves the rest of the text alone', () => {
    expect(renderEmoji('ship it :rocket: :tada:')).toBe('ship it 🚀 🎉');
  });

  it('leaves a custom shortcode as written rather than inventing one', () => {
    expect(renderEmoji('marked :done-2: by ops')).toBe('marked :done-2: by ops');
  });

  it('ignores a skin tone suffix', () => {
    expect(emojiFor('wave::skin-tone-3')).toBe('👋');
  });

  it('does not mangle a time or a ratio', () => {
    expect(renderEmoji('at 10:30 the ratio was 3:1')).toBe('at 10:30 the ratio was 3:1');
  });

  it('labels a reaction with the emoji, or its name when custom', () => {
    expect(reactionLabel('eyes')).toBe('👀');
    expect(reactionLabel('done-2')).toBe('done 2');
  });
});
