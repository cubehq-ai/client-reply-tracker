import { one, query } from '../db/pool.js';
import { getLlmClient } from '../llm/index.js';
import { localClassify } from '../llm/localClassifier.js';
import type { Classification, ClassificationInput } from '../llm/types.js';

const ACK_PATTERN = /\b(thanks|thank you|thx|got it|received|noted|perfect|great|awesome|will do|sounds good|ok|okay|understood|appreciate it|cheers|no worries|all good)\b/i;

/** Words that mean the sender still wants something, whatever else they said. */
const ASK_PATTERN = /\b(can you|could you|please|need|when|send|share|confirm|update)\b/i;

/**
 * The free pre-check (CLAUDE.md override 3). Deliberately conservative: it
 * only closes a message that is short, reads as an acknowledgement, asks no
 * question and contains no request. Anything else goes to the model.
 */
export function heuristicClassify(input: ClassificationInput): Classification | null {
  const body = input.body.trim();
  if (body.length === 0 || body.length >= 200) return null;
  if (body.includes('?')) return null;
  if (!ACK_PATTERN.test(body)) return null;
  if (ASK_PATTERN.test(body)) return null;

  return {
    needsReply: false,
    confidence: 0.9,
    summary: body.split('\n')[0]?.slice(0, 120) ?? 'Acknowledgement',
    tier: 'heuristic',
  };
}

/**
 * Classifies one external message, cached by RFC Message-ID so the same mail
 * landing in three mailboxes is paid for once (SPEC 13).
 */
export async function classifyMessage(rfcMessageId: string, input: ClassificationInput): Promise<Classification> {
  const cached = await one<{
    needs_reply: boolean; confidence: number; summary: string; tier: string; model: string | null;
  }>('SELECT needs_reply, confidence, summary, tier, model FROM classifications WHERE rfc_message_id = $1', [rfcMessageId]);

  if (cached) {
    return {
      needsReply: cached.needs_reply,
      confidence: Number(cached.confidence),
      summary: cached.summary,
      tier: cached.tier as Classification['tier'],
      model: cached.model ?? undefined,
    };
  }

  // Tier A heuristic, then the locally trained model, then the LLM. Each step
  // only answers when it is sure, so cost falls as the model learns (SPEC 13).
  const result =
    heuristicClassify(input) ??
    (await localClassify(input)) ??
    (await getLlmClient().classify(input));

  await query(
    `INSERT INTO classifications (rfc_message_id, needs_reply, confidence, summary, tier, model)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (rfc_message_id) DO NOTHING`,
    [rfcMessageId, result.needsReply, result.confidence, result.summary, result.tier, result.model ?? null],
  );

  return result;
}
