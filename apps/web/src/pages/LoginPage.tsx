import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { login, sessionKey } from '../auth/api';
import { errorMessageKey } from '../auth/errors';
import { destinationFor } from '../auth/routing';
import { AuthLayout, formClass } from '../components/AuthLayout';
import { Alert, Button, Checkbox, Hint, IconButton, TextField } from '../components/ui';
import { useT } from '../i18n';

export function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const mutation = useMutation({
    mutationFn: () => login(email, password, remember),
    onSuccess: async (session) => {
      setPassword('');
      queryClient.setQueryData(sessionKey, session);
      await navigate({ to: destinationFor(session.status) });
    },
    onError: () => setPassword(''),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <AuthLayout title={t('auth.login.title')} subtitle={t('auth.login.subtitle')}>
      <form className={formClass} onSubmit={onSubmit} noValidate>
        {mutation.isError ? <Alert>{t(errorMessageKey(mutation.error))}</Alert> : null}
        <TextField
          label={t('auth.login.email')}
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={254}
          icon="mail"
          placeholder={t('auth.login.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={mutation.isError}
        />
        <TextField
          label={t('auth.login.password')}
          type={showPassword ? 'text' : 'password'}
          name="password"
          autoComplete="current-password"
          icon="lock"
          trailing={
            <IconButton
              icon={showPassword ? 'eyeOff' : 'eye'}
              label={showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')}
              onClick={() => setShowPassword((v) => !v)}
            />
          }
          required
          maxLength={1024}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={mutation.isError}
        />
        <Checkbox
          label={t('auth.login.remember')}
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        <Button
          type="submit"
          iconEnd={mutation.isPending ? undefined : 'arrowRight'}
          disabled={mutation.isPending || !email || !password}
        >
          {mutation.isPending ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
        <Hint>{t('auth.login.appPasswordHint')}</Hint>
      </form>
    </AuthLayout>
  );
}
