import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  AVATAR_URL,
  fetchPreferences,
  preferencesKey,
  removeAvatar,
  updatePreferences,
  uploadAvatar,
  type Accent,
  type Density,
  type Preferences,
  type Theme,
} from '../api/preferences';
import { useToast } from '../components/Toast';
import { Alert, Avatar, Button, Checkbox, Hint, Segmented, TextField } from '../components/ui';
import { sessionKey, type SessionInfo } from '../auth/api';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/fr';
import { RichTextEditor, type EditorHandle } from '../mail/RichTextEditor';
import styles from './SettingsPage.module.css';

const THEMES: { value: Theme; key: MessageKey; hint: MessageKey }[] = [
  {
    value: 'auto',
    key: 'settings.appearance.themeAuto',
    hint: 'settings.appearance.themeAutoHint',
  },
  {
    value: 'light',
    key: 'settings.appearance.themeLight',
    hint: 'settings.appearance.themeLightHint',
  },
  {
    value: 'dark',
    key: 'settings.appearance.themeDark',
    hint: 'settings.appearance.themeDarkHint',
  },
];

const ACCENTS: { value: Accent; key: MessageKey }[] = [
  { value: 'indigo', key: 'settings.appearance.accentIndigo' },
  { value: 'blue', key: 'settings.appearance.accentBlue' },
  { value: 'teal', key: 'settings.appearance.accentTeal' },
  { value: 'green', key: 'settings.appearance.accentGreen' },
  { value: 'orange', key: 'settings.appearance.accentOrange' },
  { value: 'rose', key: 'settings.appearance.accentRose' },
];

const DENSITIES: { value: Density; key: MessageKey }[] = [
  { value: 'comfortable', key: 'settings.appearance.comfortable' },
  { value: 'compact', key: 'settings.appearance.compact' },
];

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Cartes de thème avec aperçu miniature (boutons radio natifs). */
function ThemeCards({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: Theme;
  onChange: (value: Theme) => void;
}) {
  const t = useT();
  // État local : le choix est reflété dès le clic, sans attendre la mise à jour du cache.
  const [selected, setSelected] = useState(value);
  useEffect(() => setSelected(value), [value]);
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.fieldLabel}>{legend}</legend>
      <div className={styles.themeCards}>
        {THEMES.map((option) => (
          <label key={option.value} className={styles.themeCard}>
            <span className={styles.themePreview} data-preview={option.value} aria-hidden="true">
              <span className={styles.previewLight} />
              <span className={styles.previewDark} />
            </span>
            <span className={styles.themeChoice}>
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={selected === option.value}
                aria-labelledby={`theme-name-${option.value}`}
                aria-describedby={`theme-hint-${option.value}`}
                onChange={() => {
                  setSelected(option.value);
                  onChange(option.value);
                }}
              />
              <span className={styles.themeText}>
                <span className={styles.themeName} id={`theme-name-${option.value}`}>
                  {t(option.key)}
                </span>
                <span className={styles.themeHint} id={`theme-hint-${option.value}`}>
                  {t(option.hint)}
                </span>
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Pastilles d'accent : boutons radio dont le nom accessible est celui de la couleur. */
function AccentSwatches({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: Accent;
  onChange: (value: Accent) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState(value);
  useEffect(() => setSelected(value), [value]);
  return (
    <fieldset className={styles.swatches}>
      <legend className="visually-hidden">{legend}</legend>
      {ACCENTS.map((option) => (
        <label key={option.value} className={styles.swatch} title={t(option.key)}>
          <input
            type="radio"
            name="accent"
            value={option.value}
            checked={selected === option.value}
            onChange={() => {
              setSelected(option.value);
              onChange(option.value);
            }}
          />
          <span
            className={styles.swatchColor}
            data-accent-swatch={option.value}
            aria-hidden="true"
          />
          <span className="visually-hidden">{t(option.key)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Ligne de réglage : libellé et explication à gauche, contrôle à droite. */
function SettingRow({
  title,
  hint,
  htmlFor,
  children,
}: {
  title: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.settingRow}>
      <div className={styles.settingText}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={styles.settingTitle}>
            {title}
          </label>
        ) : (
          <span className={styles.settingTitle}>{title}</span>
        )}
        {hint ? <span className={styles.settingHint}>{hint}</span> : null}
      </div>
      <div className={styles.settingControl}>{children}</div>
    </div>
  );
}

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} id={id} aria-labelledby={`${id}-title`}>
      <header className={styles.sectionHeader}>
        <h2 id={`${id}-title`}>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('lecture impossible'));
    reader.readAsDataURL(file);
  });
}

export function GeneralSettingsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const langId = useId();
  const prefs = useQuery({ queryKey: preferencesKey, queryFn: fetchPreferences });
  const session = queryClient.getQueryData<SessionInfo | null>(sessionKey);
  const editor = useRef<EditorHandle>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState('');
  const [photoError, setPhotoError] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  useEffect(() => {
    if (prefs.data) setDisplayName(prefs.data.displayName ?? '');
  }, [prefs.data]);

  const onSaved = (data: Preferences) => queryClient.setQueryData(preferencesKey, data);

  /** Apparence et notifications : enregistrées dès qu'elles changent. */
  const patchMutation = useMutation({
    mutationFn: (change: { change: Partial<Preferences>; previous: Preferences | undefined }) =>
      updatePreferences(change.change),
    onSuccess: onSaved,
    onError: (_error, { previous }) => {
      if (previous) queryClient.setQueryData(preferencesKey, previous);
      toast(t('common.error.generic'));
    },
  });
  /**
   * Mise à jour optimiste, appliquée de façon synchrone : le contrôle reflète le choix dès le
   * clic ; l'état précédent est rétabli si le serveur refuse.
   */
  const patch = {
    mutate: (change: Partial<Preferences>) => {
      // Une relecture en cours écraserait la valeur optimiste : elle est annulée.
      void queryClient.cancelQueries({ queryKey: preferencesKey }, { revert: false, silent: true });
      const previous = queryClient.getQueryData<Preferences>(preferencesKey);
      if (previous) queryClient.setQueryData(preferencesKey, { ...previous, ...change });
      patchMutation.mutate({ change, previous });
    },
  };

  const save = useMutation({
    mutationFn: () => updatePreferences({ signatureHtml: editor.current?.getHtml() ?? '' }),
    onSuccess: (data) => {
      onSaved(data);
      toast(t('settings.general.saved'));
    },
  });

  const photo = useMutation({
    mutationFn: async (file: File | null) => {
      if (file === null) return removeAvatar();
      if (file.size > MAX_PHOTO_BYTES) throw new Error('too_large');
      return uploadAvatar(await readAsBase64(file));
    },
    onSuccess: (_data, file) => {
      setPhotoError(false);
      void queryClient.invalidateQueries({ queryKey: preferencesKey });
      if (file) toast(t('settings.profile.photoSaved'));
    },
    onError: () => setPhotoError(true),
  });

  if (!prefs.data) return <p>{t('app.status.loading')}</p>;
  const data = prefs.data;

  const email = session?.user.email ?? '';

  /** Nom affiché : enregistré en quittant le champ (ou avec Entrée), s'il a changé. */
  const saveName = () => {
    const value = displayName.trim() || null;
    if (value === (data.displayName ?? null)) return;
    patch.mutate({ displayName: value });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  const onPhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) photo.mutate(file);
  };

  const setDesktop = async (enabled: boolean) => {
    if (enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      setPermission(await Notification.requestPermission());
    }
    patch.mutate({ notifications: { ...data.notifications, desktop: enabled } });
  };

  return (
    <>
      <h1 className="visually-hidden">{t('settings.general.title')}</h1>

      <Section
        id="compte"
        title={t('settings.account.title')}
        subtitle={t('settings.account.subtitle')}
      >
        <div className={styles.photoRow}>
          <Avatar
            name={data.displayName || email}
            size={72}
            src={data.hasAvatar ? `${AVATAR_URL}?v=${prefs.dataUpdatedAt}` : undefined}
          />
          <Button
            variant="secondary"
            onClick={() => photoInput.current?.click()}
            disabled={photo.isPending}
          >
            {t('settings.profile.photoChange')}
          </Button>
          {data.hasAvatar ? (
            <Button variant="ghost" onClick={() => photo.mutate(null)} disabled={photo.isPending}>
              {t('settings.profile.photoRemove')}
            </Button>
          ) : null}
          <input
            ref={photoInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="visually-hidden"
            tabIndex={-1}
            aria-label={t('settings.profile.photoChange')}
            onChange={onPhoto}
          />
        </div>
        <Hint>{t('settings.profile.photoHelp')}</Hint>
        {photoError ? <Alert>{t('settings.profile.photoInvalid')}</Alert> : null}
        <div className={styles.fieldGrid}>
          <TextField
            label={t('settings.general.displayName')}
            value={displayName}
            maxLength={100}
            autoComplete="name"
            onChange={(e) => setDisplayName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName();
            }}
          />
          <TextField label={t('settings.account.email')} value={email} readOnly />
        </div>
      </Section>

      <Section
        id="apparence"
        title={t('settings.appearance.title')}
        subtitle={t('settings.appearance.subtitle')}
      >
        <ThemeCards
          legend={t('settings.appearance.theme')}
          value={data.theme}
          onChange={(theme) => patch.mutate({ theme })}
        />
        <SettingRow
          title={t('settings.appearance.accent')}
          hint={t('settings.appearance.accentHint')}
        >
          <AccentSwatches
            legend={t('settings.appearance.accent')}
            value={data.accent}
            onChange={(accent) => patch.mutate({ accent })}
          />
        </SettingRow>
        <SettingRow
          title={t('settings.appearance.density')}
          hint={t('settings.appearance.densityHint')}
        >
          <Segmented
            legend={t('settings.appearance.density')}
            name="density"
            value={data.density}
            options={DENSITIES.map((o) => ({ value: o.value, label: t(o.key) }))}
            onChange={(density) => patch.mutate({ density })}
          />
        </SettingRow>
        <SettingRow
          title={t('settings.appearance.language')}
          hint={t('settings.appearance.languageHint')}
          htmlFor={langId}
        >
          <select
            id={langId}
            className={styles.select}
            value={data.language}
            onChange={(e) => patch.mutate({ language: e.target.value as Preferences['language'] })}
          >
            <option value="auto">{t('settings.appearance.languageAuto')}</option>
            <option value="fr" lang="fr">
              {t('settings.appearance.languageFr')}
            </option>
            <option value="en" lang="en">
              {t('settings.appearance.languageEn')}
            </option>
          </select>
        </SettingRow>
      </Section>

      <Section
        id="notifications"
        title={t('settings.notifications.title')}
        subtitle={t('settings.notifications.subtitle')}
      >
        <div className={styles.checkList}>
          <Checkbox
            label={t('settings.notifications.desktop')}
            checked={data.notifications.desktop}
            disabled={permission === 'unsupported'}
            onChange={(e) => void setDesktop(e.target.checked)}
          />
          {data.notifications.desktop && permission === 'denied' ? (
            <Alert tone="info">{t('settings.notifications.desktopDenied')}</Alert>
          ) : null}
          <Checkbox
            label={t('settings.notifications.sound')}
            checked={data.notifications.sound}
            onChange={(e) =>
              patch.mutate({ notifications: { ...data.notifications, sound: e.target.checked } })
            }
          />
          <Checkbox
            label={t('settings.notifications.dailyDigest')}
            checked={data.notifications.dailyDigest}
            onChange={(e) =>
              patch.mutate({
                notifications: { ...data.notifications, dailyDigest: e.target.checked },
              })
            }
          />
        </div>
      </Section>

      <Section
        id="signature"
        title={t('settings.general.signature')}
        subtitle={t('settings.signature.subtitle')}
      >
        <form className={styles.signatureForm} onSubmit={onSubmit}>
          {save.isError ? <Alert>{t('common.error.generic')}</Alert> : null}
          <div className={styles.signature}>
            <RichTextEditor
              ref={editor}
              initialHtml={data.signatureHtml}
              label={t('settings.general.signature')}
            />
          </div>
          <div>
            <Button type="submit" disabled={save.isPending}>
              {t('settings.general.save')}
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}
