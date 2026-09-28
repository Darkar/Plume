import { Outlet, useLocation } from '@tanstack/react-router';
import { useEffect } from 'react';
import styles from './SettingsPage.module.css';

/** Contenu des paramètres (la navigation est dans la barre latérale, voir AppShell). */
export function SettingsLayout() {
  const { hash } = useLocation();
  // Navigation par section (#apparence…) : la section est amenée à l'écran.
  useEffect(() => {
    if (!hash) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(hash)?.scrollIntoView({ block: 'start' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [hash]);
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <Outlet />
      </div>
    </div>
  );
}
