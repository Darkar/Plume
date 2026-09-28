import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  fetchMe,
  logoutAll,
  meKey,
  regenerateBackupCodes,
  sessionKey,
  totpDisable,
} from '../auth/api';
import { errorMessageKey } from '../auth/errors';
import { BackupCodes } from '../components/BackupCodes';
import { TotpEnrollment } from '../components/TotpEnrollment';
import { Alert, Button, Hint, TextField } from '../components/ui';
import { useT } from '../i18n';
import styles from './SecuritySettingsPage.module.css';

export function SecuritySettingsPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: meKey, queryFn: fetchMe });
  const [enrolling, setEnrolling] = useState(false);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  const disable = useMutation({
    mutationFn: () => totpDisable(code),
    onSettled: () => setCode(''),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meKey }),
  });
  const regenerate = useMutation({
    mutationFn: () => regenerateBackupCodes(code),
    onSettled: () => setCode(''),
    onSuccess: (data) => {
      setCodes(data.backupCodes);
      void queryClient.invalidateQueries({ queryKey: meKey });
    },
  });
  const signOutAll = useMutation({
    mutationFn: logoutAll,
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: '/connexion' });
    },
  });

  if (!me.data) return <p>{t('app.status.loading')}</p>;
  const { totp } = me.data;
  const error = disable.error ?? regenerate.error;

  return (
    <>
      <h1>{t('settings.security.title')}</h1>

      <section className={styles.card} aria-labelledby="totp-title">
        <h2 id="totp-title">{t('settings.security.totp')}</h2>
        {totp.policy === 'disabled' ? (
          <Hint>{t('settings.security.totpPolicyDisabled')}</Hint>
        ) : totp.enabled ? (
          <>
            <Hint>{t('settings.security.totpEnabled', { count: totp.backupCodesRemaining })}</Hint>
            {codes ? <BackupCodes codes={codes} /> : null}
            {error ? <Alert>{t(errorMessageKey(error))}</Alert> : null}
            <div className={styles.row}>
              <TextField
                label={t('settings.security.confirmCode')}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <Button
                variant="secondary"
                disabled={code.length !== 6 || regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                {t('settings.security.regenerate')}
              </Button>
              {totp.policy !== 'required' ? (
                <Button
                  variant="danger"
                  disabled={code.length !== 6 || disable.isPending}
                  onClick={() => disable.mutate()}
                >
                  {t('settings.security.disable')}
                </Button>
              ) : null}
            </div>
          </>
        ) : enrolling ? (
          <TotpEnrollment
            onDone={(session) => {
              setEnrolling(false);
              queryClient.setQueryData(sessionKey, session);
              void queryClient.invalidateQueries({ queryKey: meKey });
            }}
          />
        ) : (
          <>
            <Hint>{t('settings.security.totpDisabled')}</Hint>
            <div>
              <Button onClick={() => setEnrolling(true)}>{t('settings.security.enable')}</Button>
            </div>
          </>
        )}
      </section>

      <section className={styles.card} aria-labelledby="sessions-title">
        <h2 id="sessions-title">{t('settings.security.sessions')}</h2>
        <Hint>{t('settings.security.logoutAllHelp')}</Hint>
        <div>
          <Button
            variant="danger"
            onClick={() => signOutAll.mutate()}
            disabled={signOutAll.isPending}
          >
            {t('settings.security.logoutAll')}
          </Button>
        </div>
      </section>
    </>
  );
}
