import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Composer } from './Composer';

export interface ComposeDraft {
  to: string;
  cc: string;
  subject: string;
  /** HTML initial du corps (hors signature), déjà sûr (texte échappé). */
  bodyHtml: string;
  inReplyTo?: string;
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
