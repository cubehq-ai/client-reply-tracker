import { describe, expect, it } from 'vitest';
import { splitQuoted } from '../web/src/quoted.js';

describe('quoted history splitting', () => {
  it('keeps only what was written now, above an "On ... wrote:" block', () => {
    const body = [
      'Hi Mia,', '', 'Happy to help — Tuesday works.', '', '*Veronica Volta*', 'Senior Account Manager', '',
      'On Mon, Oct 12, 2026 at 8:15 AM Mia Dolak <mia@mount-it.com> wrote:', '', '> Hi Veronica,', '> Yes, we would like to keep support.',
    ].join('\n');
    const { visible, quoted } = splitQuoted(body);
    expect(visible).toContain('Tuesday works');
    expect(visible).not.toContain('Yes, we would like to keep support');
    expect(quoted).toContain('Yes, we would like to keep support');
  });

  it('handles an Outlook-style From: header block', () => {
    const { visible, quoted } = splitQuoted('Thanks, sending now.\n\nFrom: someone@acme.com\nSent: Monday\n\nOriginal text');
    expect(visible).toBe('Thanks, sending now.');
    expect(quoted).toContain('From: someone@acme.com');
  });

  it('handles a forwarded block', () => {
    const { visible, quoted } = splitQuoted('FYI below.\n\n--------- Forwarded message ---------\nFrom: a@b.com');
    expect(visible).toBe('FYI below.');
    expect(quoted).toContain('Forwarded message');
  });

  it('returns no quoted part for a plain message', () => {
    const { visible, quoted } = splitQuoted('Can you confirm the invoice?');
    expect(visible).toBe('Can you confirm the invoice?');
    expect(quoted).toBe('');
  });

  it('does not treat a single inline > as the start of history', () => {
    const { visible, quoted } = splitQuoted('Use a value > 10 for the threshold.\nThat is all.');
    expect(visible).toContain('That is all');
    expect(quoted).toBe('');
  });

  it('copes with an empty body', () => {
    expect(splitQuoted('')).toEqual({ visible: '', quoted: '' });
  });
});
