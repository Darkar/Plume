import { useInfiniteQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { sessionKey, type SessionInfo } from '../auth/api';
import { ApiError } from '../api/client';
import { fetchMessages, mailKeys, type ListFilter } from '../api/mail';
import { useT } from '../i18n';
import styles from '../mail/MailPage.module.css';
import { useLocationTitle } from '../mail/FolderList';
import { Icon } from '../mail/Icon';
import { MessageList } from '../mail/MessageList';
import { MessagePreview } from '../mail/MessagePreview';

/** Paramètres d'URL (tous facultatifs : valeurs par défaut appliquées ici). */
export interface MailSearch {
  folder?: string;
  filter?: ListFilter;
  q?: string;
  label?: string;
  m?: string;
}

export function MailPage() {
  const t = useT();
  const search = useSearch({ from: '/app/' });
  const navigate = useNavigate({ from: '/' });
  const { folder = 'INBOX', filter = 'all', q = '', label = '', m } = search;
  const queryClient = useQueryClient();
  const session = queryClient.getQueryData<SessionInfo | null>(sessionKey);

  const list = useInfiniteQuery({
    queryKey: ['messages', folder, filter, q, label],
    queryFn: ({ pageParam }) => fetchMessages(folder, filter, q, pageParam, label || undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const messages = list.data?.pages.flatMap((page) => page.messages) ?? [];
  const index = messages.findIndex((message) => message.id === m);
  const go = (patch: Partial<MailSearch>) =>
    navigate({ search: (prev: MailSearch) => ({ ...prev, ...patch }) });

  const errorCode = list.error instanceof ApiError ? list.error.code : null;
  const error = list.isError
    ? errorCode === 'imap_unavailable'
      ? t('mail.error.imapUnavailable')
      : errorCode === 'imap_auth_failed'
        ? t('mail.error.imapAuth')
        : t('common.error.generic')
    : null;

  const title = useLocationTitle({ folder, filter, label: label || undefined });

  return (
    <div className={styles.page} data-has-preview={m ? 'true' : undefined}>
      <MessageList
        title={title}
        messages={messages}
        total={list.data?.pages[0]?.total}
        selectedId={m}
        filter={filter}
        query={q}
        loading={list.isPending}
        error={error}
        hasMore={list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onSelect={(id) => void go({ m: id })}
        onFilter={(value) => void go({ filter: value, m: undefined })}
        onSearch={(value) => void go({ q: value, m: undefined })}
        onLoadMore={() => void list.fetchNextPage()}
        refreshing={list.isRefetching && !list.isFetchingNextPage}
        onRefresh={() => {
          void list.refetch();
          void queryClient.invalidateQueries({ queryKey: mailKeys.folders });
          void queryClient.invalidateQueries({ queryKey: mailKeys.labels });
        }}
      />
      {m ? (
        <MessagePreview
          id={m}
          selfEmail={session?.user.email}
          onGone={() =>
            void go({ m: messages[index + 1]?.id ?? messages[index - 1]?.id ?? undefined })
          }
          onClose={() => void go({ m: undefined })}
          position={index >= 0 ? { index: index + 1, count: messages.length } : undefined}
          onPrevious={index > 0 ? () => void go({ m: messages[index - 1]?.id }) : undefined}
          onNext={
            index >= 0 && index < messages.length - 1
              ? () => void go({ m: messages[index + 1]?.id })
              : undefined
          }
        />
      ) : (
        <section className={`${styles.previewPane} ${styles.emptyPane}`}>
          <Icon name="mail" size={28} />
          <p className={styles.state}>{t('mail.preview.empty')}</p>
        </section>
      )}
    </div>
  );
}
