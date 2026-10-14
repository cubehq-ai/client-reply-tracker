export interface ClassificationInput {
  subject: string;
  /** Cleaned body of the latest external message. */
  body: string;
  /** Cleaned body of our most recent reply, for context (SPEC 12). */
  lastInternalBody?: string;
  fromName?: string;
  clientName?: string;
}

export interface Classification {
  needsReply: boolean;
  confidence: number;
  summary: string;
  /** Which tier produced this verdict, for cost accounting and audit. */
  tier: 'heuristic' | 'llm' | 'fallback';
  model?: string;
}

export interface DraftInput {
  subject: string;
  thread: { from: string; date: string; body: string; direction: 'in' | 'out' }[];
  senderName: string;
  clientName?: string;
}

export interface LlmClient {
  classify(input: ClassificationInput): Promise<Classification>;
  draftReply(input: DraftInput): Promise<string>;
}
