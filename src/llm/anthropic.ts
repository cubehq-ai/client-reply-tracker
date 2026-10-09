import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type { Classification, ClassificationInput, DraftInput, Intent, LlmClient, Priority } from './types.js';

const CLASSIFY_SYSTEM = `You triage a B2B company's client email.
Decide whether the latest message from the client needs a reply from us.

Rules:
- "needs_reply" is true when the sender asks a question, makes a request, reports a problem, or is waiting on something from us.
- "needs_reply" is false for acknowledgements ("Thanks!", "Got it"), FYI notices, automated reports and invoices that ask for nothing.
- Judge only the latest external message. Earlier context is background.
- confidence is your own certainty, 0 to 1.
- summary is one short line in English, whatever the language of the email.

Reply with JSON only, no prose, matching exactly:
{"needs_reply": boolean, "confidence": number, "intent": "question"|"request"|"complaint"|"approval"|"fyi"|"other", "priority": "high"|"normal"|"low", "summary": string}`;

const INTENTS = new Set<Intent>(['question', 'request', 'complaint', 'approval', 'fyi', 'other']);
const PRIORITIES = new Set<Priority>(['high', 'normal', 'low']);

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;
  constructor() {
    this.client = new Anthropic({ apiKey: config.classifier.apiKey });
  }

  async classify(input: ClassificationInput): Promise<Classification> {
    const parts = [
      input.clientName ? `Client: ${input.clientName}` : null,
      input.fromName ? `From: ${input.fromName}` : null,
      `Subject: ${input.subject}`,
      input.lastInternalBody ? `\nOur last reply:\n${input.lastInternalBody.slice(0, 1500)}` : null,
      `\nLatest message from them:\n${input.body.slice(0, 3000)}`,
    ].filter(Boolean);

    const res = await this.client.messages.create({
      model: config.classifier.model,
      max_tokens: 400,
      system: CLASSIFY_SYSTEM,
      messages: [{ role: 'user', content: parts.join('\n') }],
    });

    const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    const parsed = parseJson(text);
    if (!parsed) {
      logger.warn({ text: text.slice(0, 200) }, 'classifier returned unparseable JSON; falling back to needs_reply');
      return { needsReply: true, confidence: 0.3, intent: 'other', priority: 'normal', summary: input.subject.slice(0, 120), tier: 'fallback' };
    }
    return {
      needsReply: Boolean(parsed.needs_reply),
      confidence: clamp(Number(parsed.confidence)),
      intent: INTENTS.has(parsed.intent) ? parsed.intent : 'other',
      priority: PRIORITIES.has(parsed.priority) ? parsed.priority : 'normal',
      summary: String(parsed.summary ?? '').slice(0, 300),
      tier: 'llm',
      model: config.classifier.model,
    };
  }

  async draftReply(input: DraftInput): Promise<string> {
    const transcript = input.thread
      .map((m) => `[${m.direction === 'in' ? 'THEM' : 'US'}] ${m.from} (${m.date}):\n${m.body.slice(0, 1200)}`)
      .join('\n\n---\n\n');

    const res = await this.client.messages.create({
      model: config.classifier.draftModel,
      max_tokens: 900,
      system:
        `You draft a reply for ${input.senderName} to send from their work email. ` +
        `Write the body only: no subject line, no greeting block beyond a normal salutation, no sign-off placeholders like [Your Name]. ` +
        `Match the thread's tone, be specific, and never invent facts, dates, numbers or commitments that are not in the thread. ` +
        `If information is missing, say plainly what you need from them.`,
      messages: [{ role: 'user', content: `Subject: ${input.subject}\n\n${transcript}\n\nDraft the reply.` }],
    });
    return res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
  }
}

function parseJson(text: string): any | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const braced = /\{[\s\S]*\}/.exec(candidate);
  if (!braced) return null;
  try {
    return JSON.parse(braced[0]);
  } catch {
    return null;
  }
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
