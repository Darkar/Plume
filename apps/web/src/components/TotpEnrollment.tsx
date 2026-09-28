import { useMutation } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { totpEnable, totpSetup, type SessionInfo } from '../auth/api';
import { errorMessageKey } from '../auth/errors';
import { useT } from '../i18n';
import { formClass } from './AuthLayout';
import { BackupCodes } from './BackupCodes';
import { Alert, Button, Hint, TextField } from './ui';
import styles from './ui.module.css';

/** Enrôlement TOTP : QR code (généré localement, jamais par un service tiers), puis confirmation. */
export function TotpEnrollment({ onDone }: { onDone: (session: SessionInfo) => void }) {
  const t = useT();
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<(SessionInfo & { backupCodes: string[] }) | null>(null);

  const setup = useMutation({ mutationFn: totpSetup });
  const enable = useMutation({
    mutationFn: () => totpEnable(code),
    onSuccess: (data) => setResult(data),
    onError: () => setCode(''),
  });

  useEffect(() => {
    if (!setup.data) return;
    let cancelled = false;
    QRCode.toDataURL(setup.data.uri, { errorCorrectionLevel: 'M', margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => setQr(null));
    return () => {
      cancelled = true;
    };
  }, [setup.data]);

  if (result) {
    return (
      <div className={formClass}>
        <BackupCodes codes={result.backupCodes} />
        <Button onClick={() => onDone(result)}>{t('auth.enroll.backupDone')}</Button>
      </div>
    );
  }

  if (!setup.data) {
    return (
      <div className={formClass}>
        {setup.isError ? <Alert>{t(errorMessageKey(setup.error))}</Alert> : null}
        <Button onClick={() => setup.mutate()} disabled={setup.isPending}>
          {t('auth.enroll.start')}
        </Button>
      </div>
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    enable.mutate();
  };

  return (
    <form className={formClass} onSubmit={onSubmit} noValidate>
      <Hint>{t('auth.enroll.step1')}</Hint>
      {qr ? <img src={qr} width={200} height={200} alt={t('auth.enroll.qrAlt')} /> : null}
      <Hint>{t('auth.enroll.manual')}</Hint>
      <code className={styles.code}>{setup.data.secret}</code>
      <Hint>{t('auth.enroll.step2')}</Hint>
      {enable.isError ? <Alert>{t(errorMessageKey(enable.error))}</Alert> : null}
      <TextField
        label={t('auth.totp.code')}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
      <Button type="submit" disabled={enable.isPending || code.length !== 6}>
        {t('auth.enroll.submit')}
      </Button>
    </form>
  );
}
