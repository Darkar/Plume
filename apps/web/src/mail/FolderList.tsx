import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type DragEvent } from 'react';
import { useToast } from '../components/Toast';
import {
  deleteLabel,
  fetchFolders,
  fetchLabels,
  mailKeys,
  updateMessage,
  type Folder,
} from '../api/mail';
import { IconButton, swatchFor } from '../components/ui';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/fr';
import styles from './FolderList.module.css';
import { isMessageDrag, readMessageDrop } from './drag';
import { Icon } from './Icon';
import { useRelocate } from './useRelocate';

/** Dossier des messages reportés (créé par le serveur Plume au premier report). */
export const SNOOZE_FOLDER = 'Reportés';

const SPECIAL: Record<string, { key: MessageKey; icon: string; order: number }> = {
  '\\Inbox': { key: 'mail.folder.inbox', icon: 'inbox', order: 0 },
  '\\Sent': { key: 'mail.folder.sent', icon: 'send', order: 2 },
  '\\Drafts': { key: 'mail.folder.drafts', icon: 'draft', order: 3 },
  '\\Archive': { key: 'mail.folder.archive', icon: 'archive', order: 4 },
  '\\Trash': { key: 'mail.folder.trash', icon: 'trash', order: 5 },
  '\\Junk': { key: 'mail.folder.junk', icon: 'junk', order: 6 },
};

export interface MailLocation {
  folder: string;
  filter: 'all' | 'unseen' | 'flagged' | 'attachments';
  label?: string;
}

type Target = { folder: string; flagged?: boolean; label?: string };

export function FolderList({ current }: { current: MailLocation | null }) {
  const t = useT();
  const folders = useQuery({
    queryKey: mailKeys.folders,
    queryFn: fetchFolders,
    staleTime: 30_000,
  });
  const labels = useQuery({ queryKey: mailKeys.labels, queryFn: fetchLabels, staleTime: 60_000 });
  const list = folders.data?.folders ?? [];
  const labelList = labels.data?.labels ?? [];
  const special = list
    .filter((f) => f.specialUse && SPECIAL[f.specialUse])
    .sort(
      (a, b) =>
        (SPECIAL[a.specialUse as string]?.order ?? 9) -
        (SPECIAL[b.specialUse as string]?.order ?? 9),
    );
  const snoozed = list.find((f) => f.path === SNOOZE_FOLDER && !f.specialUse);
  const others = list.filter(
    (f) => (!f.specialUse || !SPECIAL[f.specialUse]) && f.path !== SNOOZE_FOLDER,
  );
  const inbox = list.find((f) => f.specialUse === '\\Inbox')?.path ?? 'INBOX';

  const [dropKey, setDropKey] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  // Un message déplacé alors qu'il est ouvert : on referme l'aperçu.
  const relocate = useRelocate(
    (id) =>
      void navigate({
        to: '/',
        search: (prev: Record<string, unknown>) =>
          prev.m === id ? { ...prev, m: undefined } : prev,
      }),
  );
  const tag = useMutation({
    mutationFn: (change: { id: string; body: Parameters<typeof updateMessage>[1] }) =>
      updateMessage(change.id, change.body),
    onSuccess: (_data, change) => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: mailKeys.message(change.id) });
      toast(change.body.flagged ? t('mail.drop.flagged') : t('mail.drop.labelled'));
    },
    onError: () => toast(t('mail.action.failed')),
  });

  /** Dépôt d'un message : dossier → déplacement ; Favoris → étoile ; libellé → libellé ajouté. */
  const dropHandlers = (target: Target, key: string) =>
    target.folder === SNOOZE_FOLDER && !target.label
      ? {}
      : {
          onDragOver: (event: DragEvent) => {
            if (!isMessageDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropKey(key);
          },
          onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
          onDrop: (event: DragEvent) => {
            setDropKey(null);
            const dragged = readMessageDrop(event);
            if (!dragged) return;
            event.preventDefault();
            if (target.flagged) tag.mutate({ id: dragged.id, body: { flagged: true } });
            else if (target.label)
              tag.mutate({ id: dragged.id, body: { labels: { add: [target.label] } } });
            else if (target.folder !== dragged.folder)
              relocate.mutate({ id: dragged.id, kind: 'move', folder: target.folder });
          },
        };

  const isCurrent = (target: Target) =>
    current !== null &&
    current.folder === target.folder &&
    (current.label ?? '') === (target.label ?? '') &&
    (target.flagged ? current.filter === 'flagged' : current.filter !== 'flagged');

  const removeLabel = useMutation({
    mutationFn: (name: string) => deleteLabel(name),
    onSuccess: (_data, name) => {
      void queryClient.invalidateQueries({ queryKey: mailKeys.labels });
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: ['message'] });
      if (current?.label === name) void navigate({ to: '/', search: { folder: inbox } });
      toast(t('mail.label.deleted', { label: name }));
    },
    onError: () => toast(t('mail.action.failed')),
  });

  const item = (target: Target, label: string, icon: string | { dot: string }, folder?: Folder) => {
    const unseen = folder && !target.flagged && !target.label ? folder.unseen : 0;
    const key = `${target.folder}:${target.flagged ? 'f' : ''}:${target.label ?? ''}`;
    return (
      <li key={key}>
        <Link
          {...dropHandlers(target, key)}
          data-drop-target={dropKey === key || undefined}
          to="/"
          search={{
            folder: target.folder,
            filter: target.flagged ? 'flagged' : 'all',
            ...(target.label ? { label: target.label } : {}),
          }}
          className={styles.item}
          aria-current={isCurrent(target) ? 'page' : undefined}
        >
          {typeof icon === 'string' ? (
            <Icon name={icon} />
          ) : (
            <span className={styles.dot} style={{ background: icon.dot }} aria-hidden="true" />
          )}
          <span className={styles.label} title={label}>
            {label}
          </span>
          {unseen > 0 ? (
            <span className={styles.badge} aria-label={t('mail.folder.unread', { count: unseen })}>
              {unseen}
            </span>
          ) : null}
        </Link>
        {target.label ? (
          <IconButton
            icon="trash"
            label={t('mail.label.delete', { label: target.label })}
            className={styles.itemAction}
            disabled={removeLabel.isPending}
            onClick={() => {
              if (window.confirm(t('mail.label.confirmDelete', { label: target.label! }))) {
                removeLabel.mutate(target.label!);
              }
            }}
          />
        ) : null}
      </li>
    );
  };

  return (
    <nav aria-label={t('mail.folder.navigation')}>
      <ul className={styles.list}>
        {special
          .slice(0, 1)
          .map((f) => item({ folder: f.path }, t('mail.folder.inbox'), 'inbox', f))}
        {item({ folder: inbox, flagged: true }, t('mail.folder.flagged'), 'star')}
        {snoozed
          ? item({ folder: snoozed.path }, t('mail.folder.snoozed'), 'clock', snoozed)
          : null}
        {special.slice(1).map((f) => {
          const meta = SPECIAL[f.specialUse as string]!;
          return item({ folder: f.path }, t(meta.key), meta.icon, f);
        })}
      </ul>
      {labelList.length > 0 ? (
        <>
          <h2 className={styles.heading}>{t('mail.folder.labels')}</h2>
          <ul className={styles.list}>
            {labelList.map((label) =>
              item({ folder: inbox, label }, label, { dot: swatchFor(label) }),
            )}
          </ul>
        </>
      ) : null}
      {others.length > 0 ? (
        <>
          <h2 className={styles.heading}>{t('mail.folder.others')}</h2>
          <ul className={styles.list}>
            {others.map((f) => item({ folder: f.path }, f.name, 'folder', f))}
          </ul>
        </>
      ) : null}
    </nav>
  );
}

/** Titre de la vue courante (dossier, favoris ou libellé). */
export function useLocationTitle(location: MailLocation): string {
  const t = useT();
  const folders = useQuery({
    queryKey: mailKeys.folders,
    queryFn: fetchFolders,
    staleTime: 30_000,
  });
  if (location.label) return location.label;
  if (location.filter === 'flagged') return t('mail.folder.flagged');
  if (location.folder === SNOOZE_FOLDER) return t('mail.folder.snoozed');
  const folder = folders.data?.folders.find((f) => f.path === location.folder);
  const special = folder?.specialUse ? SPECIAL[folder.specialUse] : undefined;
  if (special) return t(special.key);
  if (location.folder === 'INBOX') return t('mail.folder.inbox');
  return folder?.name ?? location.folder;
}
