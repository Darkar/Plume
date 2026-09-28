import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { addAccount, cancelAddAccount, verifyAccountTotp } from '../auth/api';
import { errorMessageKey } from '../auth/errors';
import { Alert, Button, Hint, TextField } from '../components/ui';
import { useT } from '../i18n';
import { reloadApp } from '../lib/reload';
import type { MessageKey } from '../i18n/fr';
import styles from './SettingsPage.module.css';

const ERRORS: Record<string, MessageKey> = {
  account_already_open: 'accounts.error.alreadyOpen',
  too_many_accounts: 'accounts.error.tooMany',
  totp_enrollment_required: 'accounts.error.enrollment',
};

function errorKey(error: unknown): MessageKey {
  return error instanceof ApiError && ERRORS[error.code]
    ? ERRORS[error.code]!
    : errorMessageKey(error);
}

/**
 * Ajout d'un compte à la session : mêmes contrôles qu'une connexion (liste blanche, limites,
 * second facteur du compte ajouté). Le compte ajouté devient actif.
 */
export function AddAccountPage() {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [needsTotp, setNeedsTotp] = useState(false);
  // Rechargement complet : le nouveau compte actif repart d'un état propre (voir AppShell).
  const done = reloadApp;

  const add = useMutation({
    mutationFn: () => addAccount(email, password),
    onSuccess: (result) => {
      setPassword('');
      if (result.status === 'totp_required') setNeedsTotp(true);
      else done();
    },
    onError: () => setPassword(''),
  });
  const verify = useMutation({
    mutationFn: () => verifyAccountTotp(useBackup ? { backupCode: code } : { code }),
    onSuccess: done,
    onError: () => setCode(''),
  });

  const cancel = async () => {
    if (needsTotp) await cancelAddAccount().catch(() => undefined);
    await navigate({ to: '/' });
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <h1>{t('accounts.add.title')}</h1>
        <p className={styles.lead}>{t('accounts.add.subtitle')}</p>
        {!needsTotp ? (
          <form
            className={styles.narrowForm}
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              add.mutate();
            }}
            noValidate
          >
            {add.isError ? <Alert>{t(errorKey(add.error))}</Alert> : null}
            <TextField
              label={t('auth.login.email')}
              type="email"
              icon="mail"
              autoComplete="off"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextField
              label={t('auth.login.password')}
              type="password"
              icon="lock"
              autoComplete="off"
              maxLength={1024}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className={styles.formActions}>
              <Button type="submit" disabled={add.isPending || !email || !password}>
                {t('accounts.add.submit')}
              </Button>
              <Button variant="ghost" onClick={() => void cancel()}>
                {t('common.action.cancel')}
              </Button>
            </div>
            <Hint>{t('auth.login.appPasswordHint')}</Hint>
          </form>
        ) : (
          <form
            className={styles.narrowForm}
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              verify.mutate();
            }}
            noValidate
          >
            <Hint>{t('accounts.add.totpHelp')}</Hint>
            {verify.isError ? <Alert>{t(errorKey(verify.error))}</Alert> : null}
            <TextField
              key={useBackup ? 'backup' : 'code'}
              label={useBackup ? t('auth.totp.backupCode') : t('auth.totp.code')}
              inputMode={useBackup ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              maxLength={useBackup ? 32 : 6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <div className={styles.formActions}>
              <Button type="submit" disabled={verify.isPending || !code}>
                {t('auth.totp.submit')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setUseBackup(!useBackup);
                  setCode('');
                }}
              >
                {useBackup ? t('auth.totp.useApp') : t('auth.totp.useBackup')}
              </Button>
              <Button variant="ghost" onClick={() => void cancel()}>
                {t('common.action.cancel')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
