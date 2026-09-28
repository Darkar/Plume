import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Menu, Popover } from '../components/Menu';
import {
  cancelSnooze,
  fetchFolders,
  fetchSnoozes,
  mailKeys,
  snoozeMessage,
  updateMessage,
  type MessageDetail,
} from '../api/mail';
import { useToast } from '../components/Toast';
import { Button, IconButton } from '../components/ui';
import { useT } from '../i18n';
import { formatFullDate } from './format';
import { SNOOZE_FOLDER } from './FolderList';
import { Icon } from './Icon';
import { LabelChip } from './MessageList';
import styles from './MailPage.module.css';
import { useReply } from './reply';
import { useRelocate } from './useRelocate';
import { minLocalInput, snoozeDate, type SnoozePreset } from './snooze';

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/;

interface Props {
  message: MessageDetail;
  selfEmail: string | undefined;
  /** Le message a quitté le dossier courant (archivé, supprimé, déplacé). */
  onGone: () => void;
  /** Position dans la liste (« 1 sur 7 ») et navigation. */
  position?: { index: number; count: number };
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
}

export function MessageActions({
  message,
  selfEmail,
  onGone,
  position,
  onPrevious,
  onNext,
  onClose,
}: Props) {
  const t = useT();
  const toast = useToast();
  const reply = useReply(message, selfEmail);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const folders = useQuery({
    queryKey: mailKeys.folders,
    queryFn: fetchFolders,
    staleTime: 30_000,
  });
  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState(false);

  // Relectures ciblées : chacune occupe la connexion IMAP de l'utilisateur, les suivantes attendent.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['messages'] });
    void queryClient.invalidateQueries({ queryKey: mailKeys.folders });
  };
  const refreshSnoozes = () => {
    refresh();
    void queryClient.invalidateQueries({ queryKey: mailKeys.snoozes });
  };
  const refreshDetail = () => {
    void queryClient.invalidateQueries({ queryKey: mailKeys.message(message.id) });
    refresh();
  };

  const relocate = useRelocate(() => onGone());

  const snoozes = useQuery({
    queryKey: mailKeys.snoozes,
    queryFn: fetchSnoozes,
    enabled: message.folder === SNOOZE_FOLDER,
  });
  const currentSnooze = snoozes.data?.snoozes.find((s) => s.messageId === message.id);
  const unsnooze = useMutation({
    mutationFn: (snoozeId: string) => cancelSnooze(snoozeId),
    onSuccess: () => {
      onGone();
      refreshSnoozes();
      toast(t('mail.action.undone'));
    },
    onError: () => toast(t('mail.action.failed')),
  });
  const [customSnooze, setCustomSnooze] = useState(false);
  const [snoozeAt, setSnoozeAt] = useState('');
  const snooze = useMutation({
    mutationFn: (until: Date) => snoozeMessage(message.id, until),
    onSuccess: (result) => {
      setCustomSnooze(false);
      onGone();
      refreshSnoozes();
      toast(t('mail.action.snoozed', { date: formatFullDate(result.wakeAt) }), {
        duration: 5000,
        action: {
          label: t('mail.action.undo'),
          run: () => {
            cancelSnooze(result.snoozeId).then(
              () => {
                refreshSnoozes();
                toast(t('mail.action.undone'));
              },
              () => toast(t('mail.action.failed')),
            );
          },
        },
      });
    },
    onError: () => toast(t('mail.action.failed')),
  });

  const flags = useMutation({
    mutationFn: (body: Parameters<typeof updateMessage>[1]) => updateMessage(message.id, body),
    onSuccess: (_data, body) => {
      refreshDetail();
      if (body.labels) void queryClient.invalidateQueries({ queryKey: mailKeys.labels });
    },
    onError: () => toast(t('mail.action.failed')),
  });

  const addLabel = (event: FormEvent) => {
    event.preventDefault();
    const value = label.trim();
    if (!LABEL_RE.test(value)) {
      setLabelError(true);
      return;
    }
    setLabelError(false);
    setLabel('');
    flags.mutate({ labels: { add: [value] } });
  };

  const destinations = (folders.data?.folders ?? []).filter((f) => f.path !== message.folder);
  // Déjà archivé : on propose de le remettre dans la boîte de réception plutôt qu'« Archiver ».
  const allFolders = folders.data?.folders ?? [];
  const inArchive = allFolders.some(
    (f) => f.specialUse === '\\Archive' && f.path === message.folder,
  );
  const inboxPath = allFolders.find((f) => f.specialUse === '\\Inbox')?.path ?? 'INBOX';
  const inJunk = allFolders.some((f) => f.specialUse === '\\Junk' && f.path === message.folder);

  return (
    <>
      <div className={styles.toolbar} role="toolbar" aria-label={t('mail.list.title')}>
        {inArchive ? (
          <Button
            variant="secondary"
            icon="inbox"
            className={styles.archive}
            onClick={() => relocate.mutate({ id: message.id, kind: 'move', folder: inboxPath })}
            disabled={relocate.isPending}
          >
            <span className={styles.archiveLabel}>{t('mail.action.toInbox')}</span>
          </Button>
        ) : (
          <Button
            variant="secondary"
            icon="archive"
            className={styles.archive}
            onClick={() => relocate.mutate({ id: message.id, kind: 'archive' })}
            disabled={relocate.isPending}
          >
            <span className={styles.archiveLabel}>{t('mail.action.archive')}</span>
          </Button>
        )}
        <IconButton
          icon="trash"
          label={t('mail.action.delete')}
          onClick={() => relocate.mutate({ id: message.id, kind: 'delete' })}
          disabled={relocate.isPending}
        />
        {inJunk ? (
          <IconButton
            icon="notJunk"
            label={t('mail.action.notJunk')}
            onClick={() => relocate.mutate({ id: message.id, kind: 'move', folder: inboxPath })}
            disabled={relocate.isPending}
          />
        ) : (
          <IconButton
            icon="junk"
            label={t('mail.action.junk')}
            onClick={() => relocate.mutate({ id: message.id, kind: 'junk' })}
            disabled={relocate.isPending}
          />
        )}
        <IconButton
          icon="markUnread"
          label={message.seen ? t('mail.action.markUnread') : t('mail.action.markRead')}
          onClick={() => flags.mutate({ seen: !message.seen })}
        />
        <Menu
          icon="clock"
          label={t('mail.snooze.menu')}
          heading={t('mail.action.snooze')}
          items={[
            { label: t('mail.snooze.laterToday'), value: 'laterToday' as const },
            { label: t('mail.snooze.tomorrow'), value: 'tomorrow' as const },
            { label: t('mail.snooze.nextWeek'), value: 'nextWeek' as const },
          ]
            .map((preset) => ({
              label: preset.label,
              disabled: snooze.isPending,
              onSelect: () => snooze.mutate(snoozeDate(preset.value as SnoozePreset)),
            }))
            .concat({
              label: t('mail.snooze.custom'),
              disabled: snooze.isPending,
              onSelect: () => setCustomSnooze(true),
            })}
        />
        <Menu
          icon="move"
          label={t('mail.action.move')}
          heading={t('mail.action.moveTo')}
          items={destinations.map((f) => ({
            label: f.path,
            icon: 'folder' as const,
            onSelect: () => relocate.mutate({ id: message.id, kind: 'move', folder: f.path }),
          }))}
        />
        <Popover icon="tag" label={t('mail.action.labels')}>
          {() => (
            <form onSubmit={addLabel} className={styles.labelForm}>
              <label htmlFor="add-label">{t('mail.action.addLabel')}</label>
              <div className={styles.labelFormRow}>
                <input
                  id="add-label"
                  value={label}
                  maxLength={64}
                  placeholder={t('mail.action.addLabel')}
                  aria-invalid={labelError || undefined}
                  aria-describedby={labelError ? 'label-error' : undefined}
                  onChange={(e) => setLabel(e.target.value)}
                  autoFocus
                />
                <IconButton icon="plus" label={t('mail.action.addLabel')} type="submit" />
              </div>
              {labelError ? (
                <span id="label-error" role="alert" className={styles.labelError}>
                  {t('mail.action.labelInvalid')}
                </span>
              ) : null}
            </form>
          )}
        </Popover>
        <span className={styles.toolbarDivider} aria-hidden="true" />
        <IconButton
          icon="reply"
          label={t('mail.action.reply')}
          onClick={() => void reply('reply')}
        />
        <Menu
          icon="more"
          label={t('mail.action.more')}
          items={[
            {
              label: t('mail.action.replyAll'),
              icon: 'replyAll',
              onSelect: () => void reply('replyAll'),
            },
            {
              label: t('mail.action.forward'),
              icon: 'forward',
              onSelect: () => void reply('forward'),
            },
            {
              label: t('mail.action.createRule'),
              icon: 'rules',
              onSelect: () =>
                void navigate({ to: '/parametres/regles', search: { depuis: message.id } }),
            },
          ]}
        />
        <span className={styles.spacer} />
        {position ? (
          <span className={styles.position}>
            {t('mail.preview.position', { index: position.index, count: position.count })}
          </span>
        ) : null}
        <IconButton
          icon="chevronUp"
          className={styles.stepper}
          label={t('mail.preview.previous')}
          onClick={onPrevious}
          disabled={!onPrevious}
        />
        <IconButton
          icon="chevronDown"
          className={styles.stepper}
          label={t('mail.preview.next')}
          onClick={onNext}
          disabled={!onNext}
        />
        <IconButton
          icon="close"
          label={t('mail.preview.close')}
          className={styles.closePreview}
          onClick={onClose}
        />
      </div>
      {currentSnooze ? (
        <div className={styles.banner} role="status">
          <Icon name="clock" />
          <span>{t('mail.snooze.until', { date: formatFullDate(currentSnooze.wakeAt) })}</span>
          <Button
            variant="secondary"
            onClick={() => unsnooze.mutate(currentSnooze.id)}
            disabled={unsnooze.isPending}
          >
            {t('mail.snooze.cancel')}
          </Button>
        </div>
      ) : null}
      {customSnooze ? (
        <form
          className={styles.banner}
          onSubmit={(e) => {
            e.preventDefault();
            const date = new Date(snoozeAt);
            if (!Number.isNaN(date.getTime())) snooze.mutate(date);
          }}
        >
          <label htmlFor="snooze-at">{t('mail.snooze.customLabel')}</label>
          <input
            id="snooze-at"
            type="datetime-local"
            className={styles.dateInput}
            min={minLocalInput()}
            required
            value={snoozeAt}
            onChange={(e) => setSnoozeAt(e.target.value)}
          />
          <Button type="submit" disabled={!snoozeAt || snooze.isPending}>
            {t('mail.action.snooze')}
          </Button>
          <Button variant="secondary" onClick={() => setCustomSnooze(false)}>
            {t('common.action.cancel')}
          </Button>
        </form>
      ) : null}
    </>
  );
}

/** Libellés du message, retirables d'un clic. */
export function MessageLabels({ message }: { message: MessageDetail }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (keyword: string) => updateMessage(message.id, { labels: { remove: [keyword] } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mailKeys.message(message.id) });
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: mailKeys.labels });
    },
    onError: () => toast(t('mail.action.failed')),
  });
  if (message.keywords.length === 0) return null;
  return (
    <div className={styles.headerLabels}>
      {message.keywords.map((keyword) => (
        <LabelChip key={keyword} label={keyword}>
          <button
            type="button"
            className={styles.chipRemove}
            aria-label={t('mail.action.removeLabel', { label: keyword })}
            onClick={() => remove.mutate(keyword)}
          >
            <Icon name="close" size={12} />
          </button>
        </LabelChip>
      ))}
    </div>
  );
}
