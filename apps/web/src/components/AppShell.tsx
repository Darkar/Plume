import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { logout, removeAccount, sessionKey, switchAccount, type SessionInfo } from '../auth/api';
import { useT } from '../i18n';
import { reloadApp } from '../lib/reload';
import { ComposeProvider, useCompose } from '../mail/ComposeContext';
import { FolderList, type MailLocation } from '../mail/FolderList';
import { Icon } from '../mail/Icon';
import { useMailEvents } from '../mail/useMailEvents';
import { useAppearanceSync } from '../appearance-sync';
import { AVATAR_URL, fetchPreferences, preferencesKey } from '../api/preferences';
import styles from './AppShell.module.css';
import { Brand } from './AuthLayout';
import { Menu } from './Menu';
import { ToastProvider, useToast } from './Toast';
import { Avatar, Button, IconButton } from './ui';

function NewMessageButton() {
  const t = useT();
  const compose = useCompose();
  return (
    <Button className={styles.newMessage} icon="pen" onClick={() => compose()}>
      {t('mail.action.new')}
    </Button>
  );
}

export function AppShell() {
  return (
    <ToastProvider>
      <ComposeProvider>
        <Shell />
      </ComposeProvider>
    </ToastProvider>
  );
}

function AccountCard() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const session = queryClient.getQueryData<SessionInfo | null>(sessionKey);
  const prefs = useQuery({
    queryKey: preferencesKey,
    queryFn: fetchPreferences,
    staleTime: 60_000,
  });
  if (!session) return null;
  const name = prefs.data?.displayName || session.user.email;
  const others = (session.accounts ?? []).filter((a) => !a.active);

  // Rechargement complet après une bascule : aucune donnée d'un compte ne reste affichée ni en
  // mémoire sous l'autre, et le flux temps réel, le thème et la langue suivent le nouveau compte.
  const reloadInbox = reloadApp;
  const failed = () => toast(t('common.error.generic'));

  return (
    <div className={styles.account}>
      <Menu
        icon="users"
        label={t('app.account.menu', { email: session.user.email })}
        placement="above"
        triggerClassName={styles.accountButton}
        trigger={
          <>
            <Avatar
              name={name}
              size={36}
              // Paramètre de version : nouvelle photo affichée sans attendre le cache.
              src={prefs.data?.hasAvatar ? `${AVATAR_URL}?v=${prefs.dataUpdatedAt}` : undefined}
            />
            <span className={styles.accountText}>
              <span className={styles.accountName}>{name}</span>
              {prefs.data?.displayName ? (
                <span className={styles.accountEmail}>{session.user.email}</span>
              ) : null}
            </span>
          </>
        }
        items={[
          ...others.map((account) => ({
            label: t('app.account.switchTo', { email: account.email }),
            icon: 'user' as const,
            onSelect: () => void switchAccount(account.email).then(reloadInbox, failed),
          })),
          {
            label: t('app.account.add'),
            icon: 'userPlus' as const,
            onSelect: () => void navigate({ to: '/comptes/ajouter' }),
          },
          ...(others.length > 0
            ? [
                {
                  label: t('app.account.close', { email: session.user.email }),
                  icon: 'logout' as const,
                  onSelect: () => void removeAccount(session.user.email).then(reloadInbox, failed),
                },
              ]
            : []),
        ]}
      />
      <Link
        to="/parametres"
        className={styles.accountSettings}
        aria-label={t('app.nav.settings')}
        title={t('app.nav.settings')}
      >
        <Icon name="settings" />
      </Link>
    </div>
  );
}

function MailSidebar({ current }: { current: MailLocation | null }) {
  return (
    <>
      <Brand className={styles.brand} />
      <NewMessageButton />
      <FolderList current={current} />
      <div className={styles.spacer} />
      <AccountCard />
    </>
  );
}

const SETTINGS_SECTIONS = [
  { hash: 'compte', icon: 'user', key: 'settings.nav.account' },
  { hash: 'apparence', icon: 'contrast', key: 'settings.nav.appearance' },
  { hash: 'notifications', icon: 'bell', key: 'settings.nav.notifications' },
  { hash: 'signature', icon: 'pen', key: 'settings.nav.signature' },
] as const;

function SettingsSidebar() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const signOut = useMutation({
    mutationFn: logout,
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: '/connexion' });
    },
  });
  const onGeneral = location.pathname === '/parametres' || location.pathname === '/parametres/';
  const hash = location.hash || 'compte';
  return (
    <>
      <Link to="/" className={styles.back} aria-label={t('settings.nav.backToInbox')}>
        <Icon name="arrowLeft" size={16} />
        <span>{t('settings.nav.back')}</span>
      </Link>
      <p className={`display ${styles.settingsTitle}`} aria-hidden="true">
        {t('app.nav.settings')}
      </p>
      <nav aria-label={t('app.nav.settings')}>
        <ul className={styles.settingsNav}>
          {SETTINGS_SECTIONS.map((section) => (
            <li key={section.hash}>
              <Link
                to="/parametres"
                hash={section.hash}
                className={styles.settingsLink}
                activeOptions={{ includeHash: true }}
                data-current={onGeneral && hash === section.hash ? 'true' : undefined}
              >
                <Icon name={section.icon} />
                <span>{t(section.key)}</span>
              </Link>
            </li>
          ))}
          <li>
            <Link to="/parametres/regles" className={styles.settingsLink}>
              <Icon name="rules" />
              <span>{t('settings.nav.rules')}</span>
            </Link>
          </li>
          <li>
            <Link to="/parametres/securite" className={styles.settingsLink}>
              <Icon name="shield" />
              <span>{t('settings.nav.security')}</span>
            </Link>
          </li>
        </ul>
      </nav>
      <div className={styles.spacer} />
      <Button
        variant="ghost"
        icon="logout"
        className={styles.logout}
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
      >
        {t('app.nav.logout')}
      </Button>
    </>
  );
}

function Shell() {
  const t = useT();
  const location = useLocation();
  const search = useSearch({ strict: false }) as Partial<MailLocation>;
  useMailEvents();
  useAppearanceSync();
  const inSettings = location.pathname.startsWith('/parametres');

  const current: MailLocation | null =
    location.pathname === '/'
      ? { folder: search.folder ?? 'INBOX', filter: search.filter ?? 'all', label: search.label }
      : null;

  // Écran étroit : la barre latérale devient un tiroir, ouvert depuis la barre supérieure.
  const mobile = useMediaQuery('(max-width: 760px)');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const compose = useCompose();
  useEffect(() => setDrawerOpen(false), [location.href]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  // Tiroir fermé : hors d'atteinte du clavier et des lecteurs d'écran.
  const drawerHidden = mobile && !drawerOpen ? { inert: '' } : {};

  return (
    <div className={styles.shell} data-drawer-open={drawerOpen || undefined}>
      <a href="#contenu" className={styles.skip}>
        {t('app.nav.skipToContent')}
      </a>
      {mobile ? (
        <header className={styles.mobileBar}>
          <IconButton
            icon="menu"
            label={t('app.nav.menu')}
            aria-expanded={drawerOpen}
            aria-controls="navigation"
            onClick={() => setDrawerOpen((v) => !v)}
          />
          <Brand className={styles.mobileBrand} />
          {!inSettings ? (
            <IconButton icon="pen" label={t('mail.action.new')} onClick={() => compose()} />
          ) : null}
        </header>
      ) : null}
      {mobile && drawerOpen ? (
        <div className={styles.backdrop} aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      ) : null}
      <aside className={styles.sidebar} id="navigation" {...drawerHidden}>
        {inSettings ? <SettingsSidebar /> : <MailSidebar current={current} />}
      </aside>
      <main className={styles.content} id="contenu" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

/** Suit une requête média (ex. largeur d'écran). */
function useMediaQuery(query: string): boolean {
  const get = () => typeof matchMedia === 'function' && matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
