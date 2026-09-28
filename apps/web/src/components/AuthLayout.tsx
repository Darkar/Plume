import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { Icon } from '../mail/Icon';
import styles from './AuthLayout.module.css';
import { Avatar } from './ui';

/** Marque : plume blanche sur tuile violette (claire et plume sombre en thème sombre). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      className={[styles.logo, className].filter(Boolean).join(' ')}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" className={styles.logoTile} />
      <path
        d="M22 7c-6 1-11 6-12 13l-2 5 2 1 2-4c5 0 10-3 11-9l-4 1 3-3c1-1 0-3 0-4z"
        className={styles.logoMark}
      />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  const t = useT();
  return (
    <div className={[styles.brand, className].filter(Boolean).join(' ')}>
      <Logo />
      <span className={`serif ${styles.brandName}`}>{t('app.brand.name')}</span>
    </div>
  );
}

/** Panneau décoratif (masqué aux technologies d'assistance) : aperçu d'une boîte calme. */
function Showcase() {
  const t = useT();
  return (
    <aside className={styles.showcase} aria-hidden="true">
      <div className={styles.cards}>
        <div className={`${styles.sample} ${styles.sample1}`}>
          <Avatar name="Camille Durand" size={40} />
          <div className={styles.sampleText}>
            <strong>Camille Durand</strong>
            <span>{t('auth.aside.sample1')}</span>
          </div>
          <time>10:42</time>
        </div>
        <div className={`${styles.sample} ${styles.sample2}`}>
          <Avatar name="Léa Bernard" size={40} />
          <div className={styles.sampleText}>
            <strong>Léa Bernard</strong>
            <span>{t('auth.aside.sample2')}</span>
          </div>
          <span className={styles.badge}>
            <Icon name="check" size={14} />
            {t('auth.aside.archived')}
          </span>
        </div>
        <div className={`${styles.sample} ${styles.sample3}`}>
          <Avatar name="Hugo Martin" size={40} />
          <div className={styles.sampleText}>
            <strong>Hugo Martin</strong>
            <span>{t('auth.aside.sample3')}</span>
          </div>
          <time>09:15</time>
        </div>
      </div>
      <div className={styles.tagline}>
        <p className={`display ${styles.taglineTitle}`}>
          {t('auth.aside.title1')}
          <br />
          <em>{t('auth.aside.title2')}</em>
        </p>
        <p className={styles.taglineText}>{t('auth.aside.text')}</p>
      </div>
    </aside>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <Brand />
        <main className={styles.main} id="contenu">
          <section className={styles.panel} aria-labelledby="auth-title">
            <div>
              <h1 className={`display ${styles.title}`} id="auth-title">
                {title}
              </h1>
              {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
            </div>
            {children}
          </section>
        </main>
        <footer className={styles.footer}>
          {t('auth.footer.copyright', { year: new Date().getFullYear() })}
        </footer>
      </div>
      <Showcase />
    </div>
  );
}

export const formClass = styles.form;
