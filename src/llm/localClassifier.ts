import { one, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import type { Classification, ClassificationInput } from './types.js';

/**
 * A bag-of-words Naive Bayes model trained on what the team actually did
 * (SPEC 13): a reply means the mail needed one, an ignore means it did not.
 *
 * This is the cheap stand-in for the embedding classifier in SPEC 15 phase 4.
 * It runs before the LLM and only answers when it is confident and has enough
 * training data, so it reduces paid calls without silently taking over
 * judgement. The model is small enough to live in the settings table.
 */

const MODEL_KEY = 'local_classifier_v1';
const MIN_EXAMPLES = 40;
const MIN_CONFIDENCE = 0.85;

interface ModelData {
  trainedAt: string;
  examples: { needsReply: number; fyi: number };
  /** token -> [count in needs_reply, count in fyi] */
  counts: Record<string, [number, number]>;
  vocabSize: number;
}

const STOP = new Set('a an the and or but if is are was were be been being to of in on at for with from by as it its this that these those i you we they he she him her them our your their me my us do does did have has had will would can could should may might must not no yes so then than there here what which who whom when where why how all any both each few more most other some such only own same too very s t just don now'.split(' '));

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^a-z0-9?'\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 24 && !STOP.has(t))
    .slice(0, 400);
}

function features(input: ClassificationInput): string[] {
  const tokens = tokenize(`${input.subject} ${input.body}`);
  const extra: string[] = [];
  // A question mark is the single strongest signal, so make it explicit.
  if (input.body.includes('?')) extra.push('__hasquestion');
  if (input.body.trim().length < 60) extra.push('__veryshort');
  if (input.body.trim().length > 800) extra.push('__long');
  return [...tokens, ...extra];
}

/** Trains from historical outcomes and stores the model. */
export async function trainLocalClassifier(): Promise<{ trained: boolean; examples: number; reason?: string }> {
  const rows = await query<{ label: string; subject: string; body: string }>(
    `SELECT
        CASE
          WHEN i.state IN ('replied','needs_reply') AND i.replied_at IS NOT NULL THEN 'needs_reply'
          WHEN i.state = 'ignored' AND i.ignore_reason = 'not_needed' THEN 'fyi'
          WHEN i.state = 'fyi' THEN 'fyi'
          ELSE NULL
        END AS label,
        COALESCE(c.subject, '') AS subject,
        COALESCE(m.body_text_trunc, m.snippet, '') AS body
       FROM items i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN LATERAL (
         SELECT body_text_trunc, snippet FROM messages
          WHERE conversation_id = i.conversation_id AND direction = 'in'
          ORDER BY internal_date DESC LIMIT 1
       ) m ON true
      WHERE i.state IN ('replied','ignored','fyi','needs_reply')`,
  );

  const usable = rows.filter((r) => r.label !== null && (r.body || r.subject));
  if (usable.length < MIN_EXAMPLES) {
    return { trained: false, examples: usable.length, reason: `need at least ${MIN_EXAMPLES} labelled items` };
  }

  const counts: Record<string, [number, number]> = {};
  let needsReply = 0;
  let fyi = 0;

  for (const r of usable) {
    const isNeeds = r.label === 'needs_reply';
    isNeeds ? (needsReply += 1) : (fyi += 1);
    const seen = new Set(features({ subject: r.subject, body: r.body }));
    for (const token of seen) {
      const entry = counts[token] ?? [0, 0];
      entry[isNeeds ? 0 : 1] += 1;
      counts[token] = entry;
    }
  }

  // Drop tokens seen once: they only memorise individual emails.
  for (const [token, [a, b]] of Object.entries(counts)) {
    if (a + b < 2) delete counts[token];
  }

  const model: ModelData = {
    trainedAt: new Date().toISOString(),
    examples: { needsReply, fyi },
    counts,
    vocabSize: Object.keys(counts).length,
  };

  await query(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [MODEL_KEY, JSON.stringify(model)],
  );
  logger.info({ examples: usable.length, vocab: model.vocabSize }, 'local classifier trained');
  return { trained: true, examples: usable.length };
}

let cached: { model: ModelData; loadedAt: number } | null = null;

async function loadModel(): Promise<ModelData | null> {
  if (cached && Date.now() - cached.loadedAt < 5 * 60_000) return cached.model;
  const row = await one<{ value: ModelData }>('SELECT value FROM settings WHERE key = $1', [MODEL_KEY]);
  if (!row) return null;
  cached = { model: row.value, loadedAt: Date.now() };
  return row.value;
}

export function clearModelCache(): void { cached = null; }

/**
 * Returns a verdict only when the model is confident; null means "ask the LLM".
 * Never hides client mail on its own — a needs_reply answer is cheap to be
 * wrong about, an fyi answer is not, so fyi needs the higher bar.
 */
export async function localClassify(input: ClassificationInput): Promise<Classification | null> {
  const model = await loadModel();
  if (!model) return null;

  const total = model.examples.needsReply + model.examples.fyi;
  if (total < MIN_EXAMPLES) return null;

  // Log-space Naive Bayes with Laplace smoothing.
  let logNeeds = Math.log(model.examples.needsReply / total);
  let logFyi = Math.log(model.examples.fyi / total);
  const vocab = Math.max(1, model.vocabSize);

  for (const token of new Set(features(input))) {
    const [a, b] = model.counts[token] ?? [0, 0];
    logNeeds += Math.log((a + 1) / (model.examples.needsReply + vocab));
    logFyi += Math.log((b + 1) / (model.examples.fyi + vocab));
  }

  const max = Math.max(logNeeds, logFyi);
  const pNeeds = Math.exp(logNeeds - max);
  const pFyi = Math.exp(logFyi - max);
  const confidence = Math.max(pNeeds, pFyi) / (pNeeds + pFyi);
  const needsReply = pNeeds >= pFyi;

  if (confidence < MIN_CONFIDENCE) return null;
  // Calling something FYI removes it from the queue, so demand more certainty.
  if (!needsReply && confidence < 0.93) return null;

  return {
    needsReply,
    confidence,
    intent: needsReply ? 'question' : 'fyi',
    priority: 'normal',
    summary: (input.subject || input.body).slice(0, 120),
    tier: 'heuristic',
    model: 'local-nb-v1',
  };
}

export async function modelStatus(): Promise<{ trained: boolean; trainedAt?: string; examples?: ModelData['examples']; vocabSize?: number }> {
  const model = await loadModel();
  if (!model) return { trained: false };
  return { trained: true, trainedAt: model.trainedAt, examples: model.examples, vocabSize: model.vocabSize };
}
