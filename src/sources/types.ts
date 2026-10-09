/**
 * Channel-agnostic ingestion seam (SPEC 1, phase 4).
 *
 * The `items` model already carries `source`, and nothing in the state machine
 * is Gmail-specific: it reasons about external messages, internal replies and
 * timestamps. A Slack adapter therefore only has to produce `ChannelMessage`
 * values and let the existing pipeline do the rest.
 *
 * Gmail is the only implementation in v1. This interface exists so the Slack
 * work does not require reshaping the data model.
 */

export interface ChannelMessage {
  /** Stable id of this message within the source. */
  externalId: string;
  /** Stable id of the conversation (Slack thread_ts, Gmail RFC chain). */
  conversationKey: string;
  source: 'gmail' | 'slack';
  authorEmail: string;
  participantEmails: string[];
  subject: string;
  body: string;
  sentAt: Date;
  /** Where it arrived: a mailbox, or a Slack channel. */
  container: string;
  isAutomated: boolean;
}

export interface ChannelSource {
  name: 'gmail' | 'slack';
  /** Messages since a cursor; the cursor is opaque to the caller. */
  fetchSince(container: string, cursor: string | null): Promise<{ messages: ChannelMessage[]; cursor: string }>;
  listContainers(): Promise<string[]>;
}

/**
 * Not implemented in v1. Documented here so the shape of the work is explicit:
 * map Slack users to org emails via the Slack SCIM/users API, treat a channel
 * or DM as the container, `thread_ts` as the conversation key, and messages
 * from non-org users as external. Everything downstream is unchanged.
 */
export class SlackSourceNotImplemented implements ChannelSource {
  name = 'slack' as const;
  async fetchSince(): Promise<{ messages: ChannelMessage[]; cursor: string }> {
    throw new Error('Slack ingestion is phase 4 and not implemented in v1');
  }
  async listContainers(): Promise<string[]> {
    throw new Error('Slack ingestion is phase 4 and not implemented in v1');
  }
}
