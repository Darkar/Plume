import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { sendMessage } from '../api/mail';
import { fetchPreferences, preferencesKey } from '../api/preferences';
import { useToast } from '../components/Toast';
import { Alert, Button, IconButton } from '../components/ui';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/fr';
import type { ComposeDraft } from './ComposeContext';
import styles from './Composer.module.css';
import { formatSize } from './format';
import { Icon } from './Icon';
import { parseRecipients } from './recipients';
import { RichTextEditor, type EditorHandle } from './RichTextEditor';

interface PendingFile {
  filename: string;
  contentType: string;
  size: number;
  data: string;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('lecture impossible'));
    reader.readAsDataURL(file);
  });
}

const ERRORS: Record<string, MessageKey> = {
  no_recipient: 'mail.compose.error.noRecipient',
  attachment_too_large: 'mail.compose.error.tooLarge',
  attachments_too_large: 'mail.compose.error.tooLarge',
  payload_too_large: 'mail.compose.error.tooLarge',
  recipient_rejected: 'mail.compose.error.rejected',
  smtp_unavailable: 'mail.compose.error.unavailable',
  smtp_auth_failed: 'mail.error.imapAuth',
  rate_limited: 'mail.compose.error.rateLimited',
};

export function Composer({ draft, onClose }: { draft: ComposeDraft; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const titleId = useId();
  const editor = useRef<EditorHandle>(null);
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [bcc, setBcc] = useState('');
  const [showCopies, setShowCopies] = useState(Boolean(draft.cc));
  const [subject, setSubject] = useState(draft.subject);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const prefs = useQuery({
    queryKey: preferencesKey,
    queryFn: fetchPreferences,
    staleTime: 60_000,
  });

  // Signature ajoutée telle quelle sous le corps, sans séparateur imposé (HTML nettoyé par le
  // serveur à l'enregistrement).
  const signature = prefs.data?.signatureHtml ? `<div><br></div>${prefs.data.signatureHtml}` : '';
  const initialHtml = `<div><br></div>${signature}${draft.bodyHtml}`;

  const send = useMutation({
    mutationFn: () => {
      const lists = [to, cc, bcc].map(parseRecipients);
      const bad = lists.flatMap((l) => l.invalid);
      setInvalid(bad);
      if (bad.length > 0) throw new ApiError(400, 'invalid_recipient');
      return sendMessage({
        to: lists[0]!.valid,
        cc: lists[1]!.valid,
        bcc: lists[2]!.valid,
        subject,
        html: editor.current?.getHtml() ?? '',
        inReplyTo: draft.inReplyTo,
        attachments: files.map(({ filename, contentType, data }) => ({
          filename,
          contentType,
          data,
        })),
      });
    },
    // Envoi en arrière-plan : la fenêtre est masquée pendant l'envoi et réapparaît, brouillon
    // intact, si le serveur refuse.
    onMutate: () => toast(t('mail.compose.sending'), { duration: 2500 }),
    onSuccess: () => {
      toast(t('mail.compose.sent'));
      void queryClient.invalidateQueries({ queryKey: ['messages'], refetchType: 'none' });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      onClose();
    },
  });
  const [expanded, setExpanded] = useState(false);

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])];
    event.target.value = '';
    // Vérification immédiate des limites (le serveur les applique aussi) : pas d'envoi voué à l'échec.
    const limits = prefs.data?.limits;
    if (limits) {
      const total =
        files.reduce((sum, f) => sum + f.size, 0) + selected.reduce((sum, f) => sum + f.size, 0);
      const tooBig = selected.find((f) => f.size > limits.maxAttachmentSize);
      if (tooBig || total > limits.maxUploadTotal) {
        setSizeError(
          tooBig
            ? t('mail.compose.fileTooLarge', {
                name: tooBig.name,
                max: formatSize(limits.maxAttachmentSize),
              })
            : t('mail.compose.totalTooLarge', { max: formatSize(limits.maxUploadTotal) }),
        );
        return;
      }
    }
    setSizeError(null);
    const added = await Promise.all(
      selected.map(async (file) => ({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        data: await readAsBase64(file),
      })),
    );
    setFiles((current) => [...current, ...added]);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send.mutate();
  };

  const errorKey =
    send.error instanceof ApiError
      ? send.error.code === 'invalid_recipient' || send.error.code === 'invalid_request'
        ? 'mail.compose.error.invalidRecipient'
        : (ERRORS[send.error.code] ?? 'common.error.generic')
      : send.error
        ? 'common.error.network'
        : null;

  return (
    <section
      className={`${styles.composer} ${expanded ? styles.expanded : ''}`}
      role="dialog"
      aria-labelledby={titleId}
      hidden={send.isPending}
    >
      <header className={styles.header}>
        <h2 id={titleId}>
          {draft.inReplyTo ? t('mail.compose.titleReply') : t('mail.compose.title')}
        </h2>
        <div className={styles.headerActions}>
          <IconButton
            icon={expanded ? 'minimize' : 'maximize'}
            label={expanded ? t('mail.compose.shrink') : t('mail.compose.expand')}
            pressed={expanded}
            onClick={() => setExpanded((v) => !v)}
          />
          <IconButton icon="close" label={t('mail.compose.close')} onClick={onClose} />
        </div>
      </header>
      <form onSubmit={onSubmit} className={styles.form} noValidate>
        {sizeError ? <Alert>{sizeError}</Alert> : null}
        {errorKey ? (
          <Alert>
            {t(errorKey as MessageKey)}
            {invalid.length > 0 ? ` (${invalid.join(', ')})` : ''}
          </Alert>
        ) : null}
        <div className={styles.row}>
          <label htmlFor={`${titleId}-to`}>{t('mail.compose.to')}</label>
          <input
            id={`${titleId}-to`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoComplete="email"
            maxLength={10_000}
          />
          {!showCopies ? (
            <button type="button" className={styles.linkButton} onClick={() => setShowCopies(true)}>
              {t('mail.compose.showCopies')}
            </button>
          ) : null}
        </div>
        {showCopies ? (
          <>
            <label className={styles.row}>
              <span>{t('mail.compose.cc')}</span>
              <input value={cc} onChange={(e) => setCc(e.target.value)} maxLength={10_000} />
            </label>
            <label className={styles.row}>
              <span>{t('mail.compose.bcc')}</span>
              <input value={bcc} onChange={(e) => setBcc(e.target.value)} maxLength={10_000} />
            </label>
          </>
        ) : null}
        <label className={styles.row}>
          <span>{t('mail.compose.subject')}</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={900} />
        </label>
        <RichTextEditor
          ref={editor}
          initialHtml={prefs.isPending ? '' : initialHtml}
          label={t('mail.compose.body')}
        />
        {files.length > 0 ? (
          <ul className={styles.files}>
            {files.map((file, index) => (
              <li key={`${file.filename}-${index}`}>
                <span>{file.filename}</span>
                <span className={styles.size}>{formatSize(file.size)}</span>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setFiles((list) => list.filter((_, i) => i !== index))}
                >
                  {t('mail.compose.removeFile')}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <footer className={styles.footer}>
          <Button type="submit" iconEnd="send" disabled={send.isPending}>
            {send.isPending ? t('mail.compose.sending') : t('mail.compose.send')}
          </Button>
          <label className={styles.attach}>
            <input
              type="file"
              multiple
              onChange={(e) => void onFiles(e)}
              className="visually-hidden"
            />
            <Icon name="paperclip" size={16} />
            <span>{t('mail.compose.attach')}</span>
          </label>
        </footer>
      </form>
    </section>
  );
}
