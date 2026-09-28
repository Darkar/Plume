import { useState } from 'react';
import { useT } from '../i18n';
import { Button, Hint } from './ui';
import styles from './ui.module.css';

export function BackupCodes({ codes }: { codes: string[] }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <section aria-labelledby="backup-title">
      <h2 id="backup-title" className={styles.sectionTitle}>
        {t('auth.enroll.backupTitle')}
      </h2>
      <Hint>{t('auth.enroll.backupHelp')}</Hint>
      <ul className={styles.codes}>
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true));
        }}
      >
        {copied ? t('common.action.copied') : t('common.action.copy')}
      </Button>
    </section>
  );
}
