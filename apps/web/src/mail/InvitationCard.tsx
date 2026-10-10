import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  attachmentUrl,
  fetchInvitation,
  mailKeys,
  replyToInvitation,
  type InvitationReply,
  type ParticipationStatus,
  type MessageDetail,
} from '../api/mail';
import { Button } from '../components/ui';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/fr';
import { formatEventRange } from './format';
import { Icon } from './Icon';
import styles from './InvitationCard.module.css';

const REPLIES: InvitationReply[] = ['accepted', 'tentative', 'declined'];

const statusKey = (status: ParticipationStatus) =>
  `mail.invitation.status.${status === 'needs-action' ? 'needsAction' : status}` as MessageKey;

/**
 * Carte d'une invitation (iCalendar) : l'événement est analysé par le serveur et affiché ici en
 * texte (jamais de HTML venant de l'invitation). Réponse Oui / Peut-être / Non envoyée à
 * l'organisateur par le serveur (iMIP).
 */
export function InvitationCard({ message }: { message: MessageDetail }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const invitation = useQuery({
    queryKey: mailKeys.invitation(message.id),
    queryFn: () => fetchInvitation(message.id),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const reply = useMutation({
    mutationFn: (status: InvitationReply) => replyToInvitation(message.id, status),
    onSuccess: (_result, status) => {
      const organizer = invitation.data?.organizer;
      toast(t('mail.invitation.sent', { name: organizer?.name || organizer?.email || '' }));
      queryClient.setQueryData<MessageDetail>(mailKeys.message(message.id), (current) =>
        current ? { ...current, invitationResponse: status } : current,
      );
    },
    onError: () => toast(t('mail.invitation.failed')),
  });

  const data = invitation.data;
  // Invitation illisible : la pièce jointe reste disponible, sans carte.
  if (!data) return null;

  const when = formatEventRange(data.start, data.end);
  const sender = message.from[0]?.address.toLowerCase();
  const mismatch =
    data.method === 'REQUEST' &&
    data.organizer !== null &&
    sender !== undefined &&
    data.organizer.email !== sender;
  const canReply =
    data.method === 'REQUEST' && !data.cancelled && data.organizer !== null && !data.organizerIsMe;
  const current =
    reply.variables && reply.isPending
      ? reply.variables
      : (message.invitationResponse ??
        (data.me && data.me.status !== 'needs-action' && data.me.status !== 'delegated'
          ? data.me.status
          : null));
  const file = message.attachments.find(
    (a) =>
      a.contentType === 'text/calendar' ||
      a.contentType === 'application/ics' ||
      /\.ics$/i.test(a.filename),
  );
  const organizerName = data.organizer
    ? data.organizer.name
      ? `${data.organizer.name} <${data.organizer.email}>`
      : data.organizer.email
    : '';
  const kind = `mail.invitation.kind.${data.method}` as MessageKey;

  return (
    <section
      className={`${styles.card} ${data.cancelled ? styles.cancelled : ''}`}
      aria-labelledby="invitation-title"
    >
      <p className={styles.kind}>
        <Icon name="calendar" size={16} />
        {t(kind)}
      </p>
      <h3 id="invitation-title" className={styles.title}>
        {data.summary || t('mail.invitation.untitled')}
      </h3>
      <ul className={styles.facts}>
        {when ? (
          <li>
            <Icon name="clock" size={16} />
            <span>
              {when.text}
              {when.allDay ? ` · ${t('mail.invitation.allDay')}` : null}
            </span>
          </li>
        ) : null}
        {data.recurring || data.occurrence ? (
          <li>
            <Icon name="repeat" size={16} />
            <span>
              {data.occurrence ? t('mail.invitation.occurrence') : t('mail.invitation.recurring')}
            </span>
          </li>
        ) : null}
        {data.location ? (
          <li>
            <Icon name="mapPin" size={16} />
            <span>{data.location}</span>
          </li>
        ) : null}
        {data.organizer ? (
          <li>
            <Icon name="user" size={16} />
            <span>{t('mail.invitation.organizer', { name: organizerName })}</span>
          </li>
        ) : null}
      </ul>

      {data.method === 'REPLY' ? (
        <ul className={styles.replies}>
          {data.attendees.map((a) => (
            <li key={a.email}>
              {a.name || a.email} {t(statusKey(a.status))}
            </li>
          ))}
        </ul>
      ) : null}

      {data.cancelled ? <p className={styles.note}>{t('mail.invitation.cancelledNote')}</p> : null}
      {data.organizerIsMe && !data.cancelled ? (
        <p className={styles.note}>{t('mail.invitation.ownEvent')}</p>
      ) : null}
      {mismatch && canReply ? (
        <p className={styles.warning} role="note">
          <Icon name="junk" size={16} />
          <span>{t('mail.invitation.mismatch', { email: data.organizer?.email ?? '' })}</span>
        </p>
      ) : null}

      {canReply ? (
        <div className={styles.answer} role="group" aria-labelledby="invitation-question">
          <span id="invitation-question" className={styles.question}>
            {t('mail.invitation.question')}
          </span>
          {REPLIES.map((status) => (
            <Button
              key={status}
              variant={current === status ? 'primary' : 'secondary'}
              aria-pressed={current === status}
              disabled={reply.isPending}
              onClick={() => reply.mutate(status)}
            >
              {t(`mail.invitation.${status}`)}
            </Button>
          ))}
        </div>
      ) : null}

      {data.method !== 'REPLY' && data.attendeeCount > 0 ? (
        <details className={styles.more}>
          <summary>
            {data.attendeeCount === 1
              ? t('mail.invitation.attendeesOne')
              : t('mail.invitation.attendees', { count: data.attendeeCount })}
          </summary>
          <ul>
            {data.attendees.map((a) => (
              <li key={a.email}>
                <span className={styles.person}>{a.name || a.email}</span>{' '}
                <span className={styles.status}>{t(statusKey(a.status))}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {data.description ? (
        <details className={styles.more}>
          <summary>{t('mail.invitation.details')}</summary>
          <p className={styles.description}>{data.description}</p>
        </details>
      ) : null}
      {file && data.method !== 'REPLY' ? (
        <a className={styles.download} href={attachmentUrl(file.id)} download>
          <Icon name="download" size={16} />
          {t('mail.invitation.download')}
        </a>
      ) : null}
    </section>
  );
}
