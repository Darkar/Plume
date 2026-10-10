import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import {
  attachmentUrl,
  bodyUrl,
  fetchMessage,
  mailKeys,
  updateMessage,
  type Attachment,
} from '../api/mail';
import { useEffectiveTheme } from '../appearance';
import { Avatar, Button, IconButton } from '../components/ui';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';
import { displayName, formatFullDate, formatSize } from './format';
import { Icon } from './Icon';
import { AttachmentPreview } from './AttachmentPreview';
import { InvitationCard } from './InvitationCard';
import { startMessageDrag } from './drag';
import { MessageActions, MessageLabels } from './MessageActions';
import styles from './MailPage.module.css';

interface Props {
  id: string;
  selfEmail?: string;
  onGone: () => void;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  position?: { index: number; count: number };
}

export function MessagePreview({
  id,
  selfEmail,
  onGone,
  onClose,
  onPrevious,
  onNext,
  position,
}: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const [showImages, setShowImages] = useState(false);
  const [previewed, setPreviewed] = useState<Attachment | null>(null);
  const message = useQuery({ queryKey: mailKeys.message(id), queryFn: () => fetchMessage(id) });
  const theme = useEffectiveTheme();
  const toast = useToast();
  const star = useMutation({
    mutationFn: (flagged: boolean) => updateMessage(id, { flagged }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mailKeys.message(id) });
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
    onError: () => toast(t('mail.action.failed')),
  });

  useEffect(() => setShowImages(false), [id]);

  // Le message ouvert est marqué lu côté serveur : s'il était non lu, on met à jour la liste
  // et les compteurs (sans recompter les dossiers à chaque ouverture).
  useEffect(() => {
    if (!message.data) return;
    type Pages = { pages: { messages: { id: string; seen: boolean }[] }[] };
    const wasUnseen = queryClient
      .getQueriesData<Pages>({ queryKey: ['messages'] })
      .some(([, data]) => data?.pages.some((p) => p.messages.some((m) => m.id === id && !m.seen)));
    if (!wasUnseen) return;
    queryClient.setQueriesData<Pages>(
      { queryKey: ['messages'] },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) => (m.id === id ? { ...m, seen: true } : m)),
          })),
        },
    );
    void queryClient.invalidateQueries({ queryKey: mailKeys.folders });
  }, [message.data, id, queryClient]);

  if (message.isError) {
    const code = message.error instanceof ApiError ? message.error.code : '';
    return (
      <section className={styles.previewPane}>
        <p className={styles.state} role="alert">
          {code === 'too_large' ? t('mail.preview.tooLarge') : t('common.error.generic')}
        </p>
      </section>
    );
  }
  if (!message.data) {
    return (
      <section className={styles.previewPane}>
        <p className={styles.state}>{t('app.status.loading')}</p>
      </section>
    );
  }

  const data = message.data;
  const sender = data.from[0];
  const senderName = sender ? displayName(sender) : t('mail.list.unknownSender');
  const files = data.attachments.filter((a) => !a.inline || !a.contentType.startsWith('image/'));
  const recipients = [...data.to, ...data.cc]
    .map((a) =>
      selfEmail && a.address.toLowerCase() === selfEmail.toLowerCase()
        ? t('mail.preview.toMe')
        : a.name || a.address,
    )
    .join(', ');

  return (
    <article className={styles.previewPane} aria-labelledby="preview-subject">
      <MessageActions
        message={data}
        selfEmail={selfEmail}
        onGone={onGone}
        position={position}
        onPrevious={onPrevious}
        onNext={onNext}
        onClose={onClose}
      />

      <div className={styles.previewScroll}>
        <header className={styles.previewHeader}>
          <MessageLabels message={data} />
          <h2
            id="preview-subject"
            className={`display ${styles.previewSubject}`}
            // Le message ouvert se glisse aussi par son titre vers un dossier ou un libellé
            // (utile quand l'écran étroit masque la liste).
            draggable
            onDragStart={(event) => startMessageDrag(event, data)}
            title={t('mail.preview.dragHint')}
          >
            {data.subject || t('mail.list.noSubject')}
          </h2>
          <div className={styles.senderBlock}>
            <Avatar name={sender?.name || sender?.address || '?'} size={48} />
            <div className={styles.senderText}>
              <div>
                <span className={styles.senderName}>{senderName}</span>{' '}
                {sender?.address ? (
                  <span className={styles.senderAddress}>&lt;{sender.address}&gt;</span>
                ) : null}
              </div>
              <div className={styles.senderMeta}>
                {recipients ? t('mail.preview.toLine', { recipients }) : null}
                {recipients && data.date ? ' · ' : null}
                <time dateTime={data.date ?? undefined}>{formatFullDate(data.date)}</time>
              </div>
            </div>
            <IconButton
              icon="star"
              label={data.flagged ? t('mail.action.unstar') : t('mail.action.star')}
              pressed={data.flagged}
              className={data.flagged ? styles.starred : undefined}
              onClick={() => star.mutate(!data.flagged)}
            />
          </div>
        </header>

        {data.blockedRemoteImages > 0 && !showImages ? (
          <div className={styles.banner} role="status">
            <Icon name="image" />
            <span>{t('mail.preview.imagesBlocked', { count: data.blockedRemoteImages })}</span>
            <Button variant="secondary" onClick={() => setShowImages(true)}>
              {t('mail.preview.showImages')}
            </Button>
          </div>
        ) : null}

        {data.invitation ? <InvitationCard message={data} /> : null}

        <MailBody
          key={`${id}:${showImages}:${theme}`}
          title={t('mail.preview.bodyTitle')}
          src={bodyUrl(id, showImages, theme)}
        />

        {files.length > 0 ? (
          <section className={styles.attachments} aria-labelledby="attachments-title">
            <h3 id="attachments-title" className="visually-hidden">
              {t('mail.preview.attachments', { count: files.length })}
            </h3>
            <ul>
              {files.map((file) => (
                <li key={file.id} className={styles.attachment}>
                  <span className={styles.fileType} aria-hidden="true">
                    {extension(file.filename)}
                  </span>
                  <span className={styles.fileText}>
                    <span className={styles.fileName}>{file.filename}</span>
                    <span className={styles.fileSize}>{formatSize(file.size)}</span>
                  </span>
                  {file.previewable ? (
                    <Button variant="ghost" onClick={() => setPreviewed(file)}>
                      {t('mail.preview.open')}
                    </Button>
                  ) : null}
                  <a
                    href={attachmentUrl(file.id)}
                    download
                    className={styles.download}
                    aria-label={t('mail.preview.downloadFile', { name: file.filename })}
                    title={t('mail.preview.download')}
                  >
                    <Icon name="download" />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {previewed ? <AttachmentPreview file={previewed} onClose={() => setPreviewed(null)} /> : null}
    </article>
  );
}

/** Extension affichée sur la vignette d'une pièce jointe (4 caractères au plus). */
function extension(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,4})$/.exec(filename);
  return (match?.[1] ?? 'FIC').toUpperCase();
}

/** Hauteur maximale acceptée (garde-fou contre une valeur aberrante). */
const MAX_BODY_HEIGHT = 200_000;

/**
 * Corps du mail dans l'iframe isolée, à la hauteur de son contenu : le mail se lit en entier
 * avec le seul défilement du panneau. La hauteur est transmise par le script de mesure du
 * document (seul script autorisé, origine opaque) ; seul un nombre est accepté, et uniquement
 * depuis cette iframe.
 */
function MailBody({ title, src }: { title: string; src: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      const { type, height: value } = data as { type?: unknown; height?: unknown };
      if (type !== 'plume:body-height' || typeof value !== 'number' || !Number.isFinite(value)) {
        return;
      }
      setHeight(Math.min(Math.max(Math.ceil(value), 0), MAX_BODY_HEIGHT));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      className={styles.body}
      data-sized={height !== null || undefined}
      style={height !== null ? { height } : undefined}
      title={title}
      src={src}
      // Isolation : origine opaque (ni cookies ni accès à l'interface) ; seul le script de mesure
      // de hauteur est autorisé par la CSP du document. Les liens s'ouvrent dans un nouvel onglet.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
    />
  );
}
