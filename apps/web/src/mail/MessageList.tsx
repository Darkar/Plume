import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ListFilter, MessageSummary } from '../api/mail';
import { Avatar, Button, IconButton, swatchFor } from '../components/ui';
import { useT } from '../i18n';
import { displayName, formatListDate } from './format';
import { startMessageDrag } from './drag';
import { Icon } from './Icon';
import styles from './MailPage.module.css';

interface Props {
  title: string;
  messages: MessageSummary[];
  total: number | undefined;
  selectedId: string | undefined;
  filter: ListFilter;
  query: string;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onFilter: (filter: ListFilter) => void;
  onSearch: (q: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function LabelChip({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <span className={styles.chip}>
      <span
        className={styles.chipDot}
        style={{ background: swatchFor(label) }}
        aria-hidden="true"
      />
      <span className={styles.chipText}>{label}</span>
      {children}
    </span>
  );
}

export function MessageList(props: Props) {
  const t = useT();
  const [search, setSearch] = useState(props.query);
  const searchInput = useRef<HTMLInputElement>(null);
  // Le champ suit la recherche active (changement de dossier, retour arrière) : jamais un texte
  // affiché qui ne filtre pas la liste.
  useEffect(() => setSearch(props.query), [props.query]);
  const filters: { value: ListFilter; label: string }[] = [
    { value: 'all', label: t('mail.list.filterAll') },
    { value: 'unseen', label: t('mail.list.filterUnseen') },
    { value: 'attachments', label: t('mail.list.filterAttachments') },
  ];

  // ⌘K / Ctrl+K : recherche.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    props.onSearch(search.trim());
  };
  const shortcut = isMac ? '⌘K' : 'Ctrl K';

  return (
    <section className={styles.listPane} aria-labelledby="list-title">
      <header className={styles.listHeader}>
        <div className={styles.listTitleRow}>
          <h1 id="list-title" className={styles.listTitle}>
            {props.title}
          </h1>
          <div className={styles.listTitleSide}>
            {props.total !== undefined ? (
              <p className={styles.count} aria-live="polite">
                {props.total === 1
                  ? t('mail.list.countOne')
                  : t('mail.list.count', { count: props.total })}
              </p>
            ) : null}
            <IconButton
              icon="refresh"
              label={t('mail.list.refresh')}
              className={props.refreshing ? styles.refreshing : undefined}
              aria-busy={props.refreshing || undefined}
              disabled={props.refreshing}
              onClick={props.onRefresh}
            />
          </div>
        </div>
        <form role="search" onSubmit={onSubmit} className={styles.search}>
          <Icon name="search" size={16} />
          <label htmlFor="mail-search" className="visually-hidden">
            {t('mail.list.search')}
          </label>
          <input
            id="mail-search"
            ref={searchInput}
            type="search"
            value={search}
            maxLength={200}
            placeholder={t('mail.list.searchPlaceholder', { folder: props.title })}
            aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
            onChange={(e) => {
              setSearch(e.target.value);
              // Champ vidé (touche d'effacement ou croix) : la liste complète revient.
              if (!e.target.value && props.query) props.onSearch('');
            }}
          />
          <kbd title={t('mail.list.searchShortcut', { keys: shortcut })}>{shortcut}</kbd>
        </form>
        {props.filter !== 'flagged' ? (
          <div className={styles.filters} role="group" aria-label={t('mail.list.title')}>
            {filters.map((f) => (
              <button
                key={f.value}
                type="button"
                className={styles.filter}
                aria-pressed={props.filter === f.value}
                onClick={() => props.onFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div className={styles.listScroll}>
        {props.error ? (
          <p className={styles.state} role="alert">
            {props.error}
          </p>
        ) : null}
        {props.loading ? <p className={styles.state}>{t('app.status.loading')}</p> : null}
        {!props.loading && !props.error && props.messages.length === 0 ? (
          <p className={styles.state}>{t('mail.list.empty')}</p>
        ) : null}

        <ul className={styles.messages}>
          {props.messages.map((message) => {
            const sender = message.from[0];
            const name = sender ? displayName(sender) : t('mail.list.unknownSender');
            const selected = message.id === props.selectedId;
            return (
              <li key={message.id}>
                <button
                  type="button"
                  className={styles.row}
                  data-unread={!message.seen || undefined}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => props.onSelect(message.id)}
                  // Glisser vers un dossier ou un libellé de la barre latérale (au clavier :
                  // menu « Déplacer » du message ouvert).
                  draggable
                  onDragStart={(event) => startMessageDrag(event, message)}
                >
                  <Avatar name={sender?.name || sender?.address || '?'} size={40} />
                  <span className={styles.rowMain}>
                    <span className={styles.rowTop}>
                      <span className={styles.sender}>
                        {!message.seen ? (
                          <span className={styles.unreadDot} aria-hidden="true" />
                        ) : null}
                        <span className={styles.rowSender}>{name}</span>
                      </span>
                      <time className={styles.date} dateTime={message.date ?? undefined}>
                        {formatListDate(message.date)}
                      </time>
                    </span>
                    <span className={styles.subject}>
                      {!message.seen ? (
                        <span className="visually-hidden">{t('mail.list.unread')} — </span>
                      ) : null}
                      {message.subject || t('mail.list.noSubject')}
                    </span>
                    {message.keywords.length > 0 || message.hasAttachments || message.flagged ? (
                      <span className={styles.meta}>
                        {message.keywords.map((keyword) => (
                          <LabelChip key={keyword} label={keyword} />
                        ))}
                        {message.hasAttachments ? (
                          <span className={styles.metaIcon} title={t('mail.list.attachment')}>
                            <Icon name="paperclip" size={14} />
                            <span className="visually-hidden">{t('mail.list.attachment')}</span>
                          </span>
                        ) : null}
                        {message.flagged ? (
                          <span
                            title={t('mail.list.flagged')}
                            className={`${styles.metaIcon} ${styles.flag}`}
                          >
                            <Icon name="star" size={14} />
                            <span className="visually-hidden">{t('mail.list.flagged')}</span>
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {props.hasMore ? (
          <div className={styles.more}>
            <Button variant="secondary" onClick={props.onLoadMore} disabled={props.loadingMore}>
              {t('mail.list.loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
