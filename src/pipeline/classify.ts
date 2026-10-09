import { one, query } from '../db/pool.js';
import { getLlmClient } from '../llm/index.js';
import type { Classification, ClassificationInput } from '../llm/types.js';

const ACK_PATTERN = /^(thanks|thank you|thx|ta|got it|received|noted|perfect|great|awesome|will do|sounds good|ok|okay|understood|appreciate it|cheers|many thanks)[\s!.,:)]*$/i;

/**
 * Tier A (SPEC 4 step 5): a very short acknowledgement with no question mark is
 * FYI without paying for a model call. Deliberately narrow — anything longer or
 * containing a question falls through to Tier B.
 */
export function heuristicClassify(input: ClassificationInput): Classification | null {
  const body = input.body.trim();
  if (body.length === 0) return null;
  if (body.length > 80 || body.includes('?')) return null;
  const firstLine = body.split('\n')[0]?.trim() ?? '';
  if (!ACK_PATTERN.test(firstLine)) return null;
  return {
    needsReply: false,
    confidence: 0.8,
    intent: 'fyi',
    priority: 'low',
    summary: `Acknowledgement: ${firstLine.slice(0, 60)}`,
    tier: 'heuristic',
  };
}

/**
 * Classifies one external message, cached by RFC Message-ID so the same mail
 * landing in three mailboxes is paid for once (SPEC 13).
 */
export async function classifyMessage(rfcMessageId: string, input: ClassificationInput): Promise<Classification> {
  const cached = await one<{
    needs_reply: boolean; confidence: number; intent: string; priority: string; summary: string; tier: string; model: string | null;
  }>('SELECT needs_reply, confidence, intent, priority, summary, tier, model FROM classifications WHERE rfc_message_id = $1', [rfcMessageId]);

  if (cached) {
    return {
      needsReply: cached.needs_reply,
      confidence: Number(cached.confidence),
      intent: cached.intent as Classification['intent'],
      priority: cached.priority as Classification['priority'],
      summary: cached.summary,
      tier: cached.tier as Classification['tier'],
      model: cached.model ?? undefined,
    };
  }

  const result = heuristicClassify(input) ?? (await getLlmClient().classify(input));

  await query(
    `INSERT INTO classifications (rfc_message_id, needs_reply, confidence, intent, priority, summary, tier, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (rfc_message_id) DO NOTHING`,
    [rfcMessageId, result.needsReply, result.confidence, result.intent, result.priority, result.summary, result.tier, result.model ?? null],
  );

  return result;
}
