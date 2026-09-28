import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { sessionKey } from '../auth/api';
import { AuthLayout } from '../components/AuthLayout';
import { TotpEnrollment } from '../components/TotpEnrollment';
import { Alert } from '../components/ui';
import { useT } from '../i18n';

/** Enrôlement imposé par la politique « totp: required ». */
export function EnrollPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <AuthLayout title={t('auth.enroll.title')}>
      <Alert tone="info">{t('auth.enroll.required')}</Alert>
      <TotpEnrollment
        onDone={async (session) => {
          queryClient.setQueryData(sessionKey, session);
          await navigate({ to: '/' });
        }}
      />
    </AuthLayout>
  );
}
