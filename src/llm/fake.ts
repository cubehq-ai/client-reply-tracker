import type { Classification, ClassificationInput, DraftInput, LlmClient } from './types.js';

const ACK = /\b(thanks|thank you|thx|got it|received|noted|perfect|great|awesome|will do|sounds good|ok|okay|understood|appreciate it|cheers|no worries|all good)\b/i;
const ASK = /\?|\b(can you|could you|would you|please|need|when|send|share|confirm|update|advise|let me know|following up|any news|waiting)\b/i;

/**
 * Offline stand-in for the model, used in tests and whenever ANTHROPIC_API_KEY
 * is unset. It answers the same question but only from keywords, so its
 * confidence is deliberately low: it is a placeholder, not a judgement.
 */
export class FakeLlmClient implements LlmClient {
  public calls = 0;

  async classify(input: ClassificationInput): Promise<Classification> {
    this.calls += 1;
    const body = input.body.trim();
    const haystack = `${input.subject}\n${body}`;

    const asks = ASK.test(haystack);
    const acknowledges = ACK.test(body) && body.length < 200;

    if (!asks && acknowledges) {
      return {
        needsReply: false,
        confidence: 0.7,
        summary: body.split('\n')[0]?.slice(0, 120) ?? 'Acknowledgement',
        tier: 'heuristic',
      };
    }

    return {
      needsReply: asks,
      // Low on purpose: without a model this is a guess, and the UI should
      // surface it as uncertain rather than confident.
      confidence: asks ? 0.55 : 0.5,
      summary: (input.subject || body).slice(0, 120),
      tier: 'heuristic',
    };
  }

  async draftReply(input: DraftInput): Promise<string> {
    const last = [...input.thread].reverse().find((m) => m.direction === 'in');
    return [
      `Hi${last ? ` ${last.from.split('@')[0]}` : ''},`,
      '',
      'Thanks for your note — I am looking into this and will come back to you shortly.',
      '',
      '(Offline placeholder draft. Set ANTHROPIC_API_KEY to generate a real one.)',
    ].join('\n');
  }
}
