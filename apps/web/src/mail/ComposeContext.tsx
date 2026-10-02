import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Composer } from './Composer';

/** Pièce jointe prête à l'envoi (contenu en base64). */
export interface PendingFile {
  filename: string;
  contentType: string;
  size: number;
  data: string;
}

export interface ComposeDraft {
  to: string;
  cc: string;
  bcc?: string;
  subject: string;
  /** HTML initial du corps (hors signature), déjà sûr (texte échappé ou nettoyé). */
  bodyHtml: string;
  inReplyTo?: string;
  /** Brouillon repris : remplacé à l'enregistrement, supprimé après l'envoi. */
  draftId?: string;
  /** Pièces jointes déjà présentes (brouillon repris). */
  attachments?: PendingFile[];
  /** Ajouter la signature (non pour un brouillon repris : elle y figure déjà). */
  withSignature?: boolean;
}

const ComposeContext = createContext<(draft?: Partial<ComposeDraft>) => void>(() => undefined);

export function useCompose() {
  return useContext(ComposeContext);
}

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<(ComposeDraft & { key: number }) | null>(null);
  const open = useCallback((partial: Partial<ComposeDraft> = {}) => {
    setDraft({ to: '', cc: '', subject: '', bodyHtml: '', ...partial, key: Date.now() });
  }, []);
  return (
    <ComposeContext.Provider value={open}>
      {children}
      {draft ? <Composer key={draft.key} draft={draft} onClose={() => setDraft(null)} /> : null}
    </ComposeContext.Provider>
  );
}
