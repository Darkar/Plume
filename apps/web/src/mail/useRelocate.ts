import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  archiveMessage,
  deleteMessage,
  junkMessage,
  mailKeys,
  moveMessage,
  type MessagePage,
  type MoveResult,
} from '../api/mail';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';

export type Relocation =
  | { id: string; kind: 'archive' }
  | { id: string; kind: 'junk' }
  | { id: string; kind: 'delete' }
  | { id: string; kind: 'move'; folder: string };

type Pages = { pages: MessagePage[]; pageParams: unknown[] };

/**
 * Archiver, supprimer, déplacer : la ligne disparaît immédiatement de la liste (mise à jour
 * optimiste) et revient si le serveur refuse. « Annuler » reste proposé 5 secondes.
 */
export function useRelocate(onGone?: (id: string) => void) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['messages'] });
    void queryClient.invalidateQueries({ queryKey: mailKeys.folders });
  };

  const undo = (result: MoveResult) => {
    if (!result.id) return undefined;
    const id = result.id;
    return {
      label: t('mail.action.undo'),
      run: () => {
        moveMessage(id, result.from).then(
          () => {
            refresh();
            toast(t('mail.action.undone'));
          },
          () => toast(t('mail.action.failed')),
        );
      },
    };
  };

  return useMutation({
    mutationFn: async (action: Relocation) => {
      if (action.kind === 'archive') return archiveMessage(action.id);
      if (action.kind === 'junk') return junkMessage(action.id);
      if (action.kind === 'delete') return deleteMessage(action.id);
      return moveMessage(action.id, action.folder);
    },
    onMutate: async (action) => {
      await queryClient.cancelQueries({ queryKey: ['messages'] });
      const snapshot = queryClient.getQueriesData<Pages>({ queryKey: ['messages'] });
      queryClient.setQueriesData<Pages>({ queryKey: ['messages'] }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => {
                const messages = page.messages.filter((m) => m.id !== action.id);
                const removed = page.messages.length - messages.length;
                return { ...page, messages, total: Math.max(0, page.total - removed) };
              }),
            }
          : data,
      );
      onGone?.(action.id);
      return { snapshot };
    },
    onError: (_error, _action, context) => {
      for (const [key, data] of (context?.snapshot ?? []) as [QueryKey, Pages | undefined][]) {
        queryClient.setQueryData(key, data);
      }
      toast(t('mail.action.failed'));
    },
    onSuccess: (result, action) => {
      const permanent = 'permanent' in result && result.permanent;
      const text =
        action.kind === 'archive'
          ? t('mail.action.archived')
          : action.kind === 'junk'
            ? t('mail.action.junked')
            : action.kind === 'delete'
              ? permanent
                ? t('mail.action.deletedForever')
                : t('mail.action.deleted')
              : t('mail.action.moved');
      toast(text, { action: permanent ? undefined : undo(result), duration: 5000 });
    },
    onSettled: () => {
      // La liste courante est déjà à jour : on la marque seulement périmée (relue à la prochaine
      // visite du dossier), sans occuper la connexion IMAP maintenant.
      void queryClient.invalidateQueries({ queryKey: ['messages'], refetchType: 'none' });
      void queryClient.invalidateQueries({ queryKey: mailKeys.folders });
    },
  });
}
