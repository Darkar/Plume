import { fetchQuote, type MessageDetail } from '../api/mail';
import { useT } from '../i18n';
import { useCompose } from './ComposeContext';
import { formatAddress, formatFullDate } from './format';
import { escapeHtml, textToHtml } from './html';
import { formatRecipients } from './recipients';

export type ReplyMode = 'reply' | 'replyAll' | 'forward';

function prefixed(prefix: 'Re' | 'Fwd', subject: string): string {
  const pattern = prefix === 'Re' ? /^re\s*:/i : /^(fwd?|tr)\s*:/i;
  return pattern.test(subject) ? subject : `${prefix}: ${subject}`;
}

/** Ouvre le composeur pour répondre, répondre à tous ou transférer (citation incluse). */
export function useReply(message: MessageDetail, selfEmail: string | undefined) {
  const t = useT();
  const compose = useCompose();
  return async (mode: ReplyMode, draftText = '') => {
    let quoted: string;
    try {
      const { text } = await fetchQuote(message.id);
      const sender = message.from[0] ? formatAddress(message.from[0]) : '';
      const header =
        mode === 'forward'
          ? `${escapeHtml(t('mail.quote.forwardHeader'))}<br>${escapeHtml(sender)}<br>${escapeHtml(message.subject)}`
          : escapeHtml(t('mail.quote.header', { date: formatFullDate(message.date), sender }));
      quoted = `<div><br></div><div>${header}</div><blockquote>${textToHtml(text)}</blockquote>`;
    } catch {
      quoted = '';
    }
    const replyTo = message.replyTo.length > 0 ? message.replyTo : message.from;
    const others = [...message.to, ...message.cc].filter(
      (a) => a.address.toLowerCase() !== selfEmail?.toLowerCase(),
    );
    compose({
      to: mode === 'forward' ? '' : formatRecipients(replyTo),
      cc: mode === 'replyAll' ? formatRecipients(others) : '',
      subject: prefixed(mode === 'forward' ? 'Fwd' : 'Re', message.subject),
      bodyHtml: (draftText.trim() ? textToHtml(draftText) : '') + quoted,
      inReplyTo: mode === 'forward' ? undefined : message.id,
    });
  };
}
