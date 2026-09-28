import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from '../mail/Icon';
import styles from './ui.module.css';

export function TextField({
  label,
  error,
  icon,
  trailing,
  labelAside,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: boolean;
  /** Icône décorative à gauche du champ. */
  icon?: IconName;
  /** Contrôle à droite du champ (ex. afficher le mot de passe). */
  trailing?: ReactNode;
  /** Élément aligné à droite du libellé (ex. lien d'aide). */
  labelAside?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {labelAside}
      </div>
      <div className={styles.control}>
        {icon ? <Icon name={icon} size={16} className={styles.leading} /> : null}
        <input
          id={id}
          className={[
            styles.input,
            icon ? styles.withIcon : '',
            trailing ? styles.withTrailing : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-invalid={error || undefined}
          {...props}
        />
        {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
      </div>
    </div>
  );
}

export function Checkbox({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={styles.checkbox}>
      <input type="checkbox" {...props} />
      {label}
    </label>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

const VARIANTS: Record<Variant, string | undefined> = {
  primary: undefined,
  secondary: styles.secondary,
  ghost: styles.ghost,
  danger: styles.danger,
  link: styles.link,
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    icon?: IconName;
    iconEnd?: IconName;
  }
>(function Button({ variant = 'primary', className, icon, iconEnd, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={[variant === 'link' ? '' : styles.button, VARIANTS[variant], className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={16} /> : null}
    </button>
  );
});

/** Bouton réduit à une icône : le libellé est obligatoire (nom accessible et info-bulle). */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    icon: IconName;
    label: string;
    pressed?: boolean;
  }
>(function IconButton({ icon, label, pressed, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={[styles.iconButton, className].filter(Boolean).join(' ')}
      {...props}
    >
      <Icon name={icon} size={18} />
    </button>
  );
});

/** Choix exclusif présenté en boutons accolés (groupe de boutons radio natifs). */
export function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className={styles.segmented}>
      <legend className="visually-hidden">{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className={styles.segment}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Alert({
  children,
  tone = 'error',
}: {
  children: ReactNode;
  tone?: 'error' | 'info';
}) {
  return (
    <div
      className={[styles.alert, tone === 'info' ? styles.info : ''].join(' ')}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}

/** Initiales d'un nom ou d'une adresse (au plus deux lettres). */
export function initials(name: string): string {
  const words = name
    .replace(/<[^>]*>/g, '')
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter((w) => /\p{L}/u.test(w));
  const letters =
    words.length > 1 ? [words[0]![0], words[words.length - 1]![0]] : [words[0]?.[0], words[0]?.[1]];
  return letters.filter(Boolean).join('').toUpperCase() || '?';
}

/** Pastille de couleur stable pour une chaîne (avatars, libellés). */
export function swatchFor(key: string): string {
  let hash = 0;
  for (const char of key.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return `var(--swatch-${(Math.abs(hash) % 8) + 1})`;
}

export function Avatar({
  name,
  src,
  size = 36,
  className,
}: {
  name: string;
  src?: string;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  if (src) {
    return (
      <img
        className={[styles.avatar, className].filter(Boolean).join(' ')}
        src={src}
        alt=""
        width={size}
        height={size}
      />
    );
  }
  return (
    <span
      className={[styles.avatar, className].filter(Boolean).join(' ')}
      style={{ ...style, background: swatchFor(name) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
