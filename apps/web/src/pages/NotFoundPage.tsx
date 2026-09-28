import { Link } from '@tanstack/react-router';
import { AuthLayout } from '../components/AuthLayout';
import { useT } from '../i18n';

export function NotFoundPage() {
  const t = useT();
  return (
    <AuthLayout title={t('common.error.notFound')}>
      <Link to="/">{t('common.action.back')}</Link>
    </AuthLayout>
  );
}
