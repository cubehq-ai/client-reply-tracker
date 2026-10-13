import { useState } from 'react';
import { splitQuoted } from './quoted';
import type { ThreadView } from './api';

type ThreadMessage = ThreadView['messages'][number];

/**
 * One message in a thread. Collapsed it is a single summary line, the way any
 * mail client shows history; expanded it shows what was written, with quoted
 * history behind its own toggle.
 */
export function Message({ message, open, onToggle, onReply, onReplyAll }: {
  message: ThreadMessage;
  open: boolean;
  onToggle: () => void;
  onReply: () => void;
  onReplyAll: () => void;
}) {
  const [showQuoted, setShowQuoted] = useState(false);
  const raw = message.body || message.snippet || '';
  const { visible, quoted } = splitQuoted(raw);
  const when = new Date(message.date);

  if (!open) {
    return (
      <button className="msg-collapsed" onClick={onToggle} title="Expand">
        <span className="msg-collapsed-from">{message.from}</span>
        <span className="msg-collapsed-preview">{(visible || message.snippet || '').slice(0, 120)}</span>
        <span className="msg-collapsed-date">{when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      </button>
    );
  }

  const to = message.to.filter(Boolean);
  const cc = message.cc.filter(Boolean);
  const bcc = (message.bcc ?? []).filter(Boolean);
  const replyAllCount = to.length + cc.length;

  return (
    <div className={`msg ${message.direction === 'out' ? 'out' : ''}`}>
      <div className="msg-head">
        <span className="msg-head-who">
          <div>
            <strong>{message.from}</strong>
            {message.isDraft && <span className="tag" style={{ marginLeft: 6 }}>draft</span>}
            {message.filterReason && <span className="tag" style={{ marginLeft: 6 }}>{message.filterReason}</span>}
          </div>
          {to.length > 0 && <div className="addr-line"><span className="addr-label">To</span>{to.join(', ')}</div>}
          {cc.length > 0 && <div className="addr-line"><span className="addr-label">Cc</span>{cc.join(', ')}</div>}
          {bcc.length > 0 && <div className="addr-line"><span className="addr-label">Bcc</span>{bcc.join(', ')}</div>}
        </span>
        <span className="msg-head-actions">
          <span className="muted">{when.toLocaleString()}</span>
          <button className="btn small" onClick={onReply} title="Reply to this message">Reply</button>
          {replyAllCount > 1 && (
            <button className="btn small" onClick={onReplyAll} title="Reply to everyone on this message">Reply all</button>
          )}
          <button className="btn small" onClick={onToggle} title="Collapse">−</button>
        </span>
      </div>

      <div className="msg-body">
        {visible || <span className="muted">(no new text in this message)</span>}
      </div>

      {quoted && (
        <div className="msg-quoted">
          <button className="quoted-toggle" onClick={() => setShowQuoted((v) => !v)}>
            {showQuoted ? 'Hide quoted text' : '••• Show quoted text'}
          </button>
          {showQuoted && <pre className="quoted-body">{quoted}</pre>}
        </div>
      )}
    </div>
  );
}
