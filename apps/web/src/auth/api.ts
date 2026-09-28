import { api, ApiError, setCsrfToken } from '../api/client';

export type SessionStatus = 'ok' | 'totp_required' | 'totp_enrollment_required';

export interface SessionInfo {
  status: SessionStatus;
  csrfToken: string;
  user: { email: string };
  /** Comptes ouverts dans la session, le compte actif en premier. */
  accounts?: { email: string; active: boolean }[];
  /** Compte en cours d'ajout, en attente de son second facteur. */
  pendingAccount?: string;
}

export type AddAccountResult = SessionInfo & { status: SessionStatus | 'totp_required' };

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
  totp: {
    policy: 'disabled' | 'optional' | 'required';
    enabled: boolean;
    backupCodesRemaining: number;
  };
  csrfToken: string;
}

export const sessionKey = ['session'] as const;
export const meKey = ['me'] as const;

/** Renvoie la session courante, ou null si l'utilisateur n'est pas connecté. */
export async function fetchSession(): Promise<SessionInfo | null> {
  try {
    return await api<SessionInfo>('GET', '/auth/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw error;
  }
}

export const login = (email: string, password: string, remember: boolean) =>
  api<SessionInfo>('POST', '/auth/login', { email, password, remember });

export const verifyTotp = (input: { code: string } | { backupCode: string }) =>
  api<SessionInfo>('POST', '/auth/totp/verify', input);

export const logout = async () => {
  await api<void>('POST', '/auth/logout');
  setCsrfToken(null);
};

export const logoutAll = async () => {
  await api<void>('POST', '/auth/logout-all');
  setCsrfToken(null);
};

export const fetchMe = () => api<Me>('GET', '/me');
export const totpSetup = () => api<{ secret: string; uri: string }>('POST', '/me/totp/setup');
export const totpEnable = (code: string) =>
  api<SessionInfo & { backupCodes: string[] }>('POST', '/me/totp/enable', { code });
export const totpDisable = (code: string) => api<void>('POST', '/me/totp/disable', { code });
export const regenerateBackupCodes = (code: string) =>
  api<{ backupCodes: string[] }>('POST', '/me/totp/backup-codes', { code });

export const addAccount = (email: string, password: string) =>
  api<AddAccountResult>('POST', '/auth/accounts', { email, password });
export const verifyAccountTotp = (input: { code: string } | { backupCode: string }) =>
  api<SessionInfo>('POST', '/auth/accounts/totp', input);
export const cancelAddAccount = () => api<void>('POST', '/auth/accounts/cancel');
export const switchAccount = (email: string) => api<SessionInfo>('POST', '/auth/switch', { email });
export const removeAccount = (email: string) =>
  api<SessionInfo | null>('POST', '/auth/accounts/remove', { email });
