import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../mail/Icon';
import styles from './Menu.module.css';
import { IconButton } from './ui';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
}

/** Ferme le panneau au clic extérieur ; renvoie l'état ouvert et ses commandes. */
function useDisclosure() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);
  return { open, setOpen, root };
}

/**
 * Menu d'actions (motif ARIA « menu button ») : flèches haut / bas, Origine / Fin, Échap pour
 * fermer en rendant le focus au bouton.
 */
export function Menu({
  icon,
  label,
  items,
  heading,
  align = 'start',
  trigger,
  triggerClassName,
  placement = 'below',
}: {
  icon: IconName;
  label: string;
  items: MenuItem[];
  heading?: string;
  align?: 'start' | 'end';
  /** Contenu d'un bouton déclencheur personnalisé (sinon, un bouton-icône). */
  trigger?: ReactNode;
  triggerClassName?: string;
  placement?: 'below' | 'above';
}) {
  const { open, setOpen, root } = useDisclosure();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const focusItem = (index: number) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    if (buttons.length === 0) return;
    buttons[(index + buttons.length) % buttons.length]?.focus();
  };

  useEffect(() => {
    if (open) focusItem(0);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const openWithArrow = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') focusItem(index + 1);
    else if (event.key === 'ArrowUp') focusItem(index - 1);
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(-1);
    else if (event.key === 'Escape') close();
    else if (event.key === 'Tab') setOpen(false);
    else return;
    if (event.key !== 'Tab') event.preventDefault();
  };

  return (
    <div className={styles.root} ref={root}>
      {trigger ? (
        <button
          ref={button}
          type="button"
          className={triggerClassName}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={openWithArrow}
        >
          {trigger}
        </button>
      ) : (
        <IconButton
          ref={button}
          icon={icon}
          label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={openWithArrow}
        />
      )}
      {open ? (
        <div
          className={[
            styles.panel,
            align === 'end' ? styles.end : '',
            placement === 'above' ? styles.above : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {heading ? (
            <p className={styles.heading} aria-hidden="true">
              {heading}
            </p>
          ) : null}
          <ul id={id} role="menu" aria-label={label} ref={list} onKeyDown={onKeyDown}>
            {items.map((item) => (
              <li key={item.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    button.current?.focus();
                    item.onSelect();
                  }}
                >
                  {item.icon ? <Icon name={item.icon} size={16} /> : null}
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Panneau non modal ouvert par un bouton-icône (formulaire court : libellés…). */
export function Popover({
  icon,
  label,
  children,
  align = 'start',
}: {
  icon: IconName;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
}) {
  const { open, setOpen, root } = useDisclosure();
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className={styles.root} ref={root}>
      <IconButton
        ref={button}
        icon={icon}
        label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={`${styles.panel} ${styles.popover} ${align === 'end' ? styles.end : ''}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
