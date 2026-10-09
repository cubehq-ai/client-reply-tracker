import type { Classification, ClassificationInput, DraftInput, Intent, LlmClient, Priority } from './types.js';

const ACK = /^(thanks|thank you|thx|ta|got it|received|noted|perfect|great|awesome|will do|sounds good|ok|okay|understood|appreciate it|cheers)[\s!.,:)]*$/i;
const QUESTION = /\?|\b(could you|can you|would you|please (send|share|confirm|advise|let)|when (can|will)|what is|how do|any update|following up|any news|waiting (on|for))\b/i;
const COMPLAINT = /\b(unacceptable|disappointed|frustrated|escalate|still (not|broken|down|failing)|third (day|time)|no update|breach|refund|cancel our)\b/i;
const URGENT = /\b(urgent|asap|immediately|critical|down|outage|blocked|blocker|today)\b/i;
const APPROVAL = /\b(approve|approved|sign(ed)? off|lgtm|go ahead|confirm(ed)? the|we agree)\b/i;

/**
 * Deterministic stand-in for the LLM. Used in tests and whenever
 * ANTHROPIC_API_KEY is unset, so the pipeline never requires a paid call.
 * It is the same logic as Tier A, extended far enough to be useful offline.
 */
export class FakeLlmClient implements LlmClient {
  public calls = 0;

  async classify(input: ClassificationInput): Promise<Classification> {
    this.calls += 1;
    const body = input.body.trim();
    const firstLine = body.split('\n')[0]?.trim() ?? '';
    const haystack = `${input.subject}\n${body}`;

    if (body.length <= 80 && ACK.test(firstLine) && !body.includes('?')) {
      return { needsReply: false, confidence: 0.82, intent: 'fyi', priority: 'low', summary: `Acknowledgement: ${firstLine.slice(0, 60)}`, tier: 'heuristic' };
    }

    let intent: Intent;
    let confidence: number;
    if (COMPLAINT.test(haystack)) { intent = 'complaint'; confidence = 0.8; }
    else if (QUESTION.test(haystack)) { intent = 'question'; confidence = 0.78; }
    else if (APPROVAL.test(haystack)) { intent = 'approval'; confidence = 0.7; }
    else if (body.length < 200) { intent = 'fyi'; confidence = 0.55; }
    else { intent = 'request'; confidence = 0.6; }

    const priority: Priority = intent === 'complaint' || URGENT.test(haystack) ? 'high' : 'normal';
    const needsReply = intent !== 'fyi';

    return {
      needsReply,
      confidence,
      intent,
      priority,
      summary: (input.subject || firstLine).slice(0, 120),
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
      '(This is an offline placeholder draft. Set ANTHROPIC_API_KEY to generate a real one.)',
    ].join('\n');
  }
}
