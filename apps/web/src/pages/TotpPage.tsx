import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { sessionKey, verifyTotp } from '../auth/api';
import { errorMessageKey } from '../auth/errors';
import { AuthLayout, formClass } from '../components/AuthLayout';
import { Alert, Button, TextField } from '../components/ui';
import { useT } from '../i18n';

export function TotpPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [useBackup, setUseBackup] = useState(false);
  const [value, setValue] = useState('');

  const mutation = useMutation({
    mutationFn: () => verifyTotp(useBackup ? { backupCode: value } : { code: value }),
    onSuccess: async (session) => {
      queryClient.setQueryData(sessionKey, session);
      await navigate({ to: '/' });
    },
    onError: async (error) => {
      setValue('');
      if (error instanceof ApiError && error.status === 429) {
        queryClient.setQueryData(sessionKey, null);
        await navigate({ to: '/connexion' });
      }
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <AuthLayout title={t('auth.totp.title')} subtitle={t('auth.totp.subtitle')}>
      <form className={formClass} onSubmit={onSubmit} noValidate>
        {mutation.isError ? <Alert>{t(errorMessageKey(mutation.error))}</Alert> : null}
        {useBackup ? (
          <TextField
            key="backup"
            label={t('auth.totp.backupCode')}
            name="backupCode"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={16}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        ) : (
          <TextField
            key="totp"
            label={t('auth.totp.code')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
            autoFocus
          />
        )}
        <Button type="submit" disabled={mutation.isPending || value.length < 6}>
          {t('auth.totp.submit')}
        </Button>
        <Button
          variant="link"
          onClick={() => {
            setUseBackup(!useBackup);
            setValue('');
            mutation.reset();
          }}
        >
          {useBackup ? t('auth.totp.useApp') : t('auth.totp.useBackup')}
        </Button>
      </form>
    </AuthLayout>
  );
}
