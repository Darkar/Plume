import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import styles from './Toast.module.css';

interface ToastItem {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  duration: number;
}

type Show = (
  message: string,
  options?: { action?: ToastItem['action']; duration?: number },
) => void;

const ToastContext = createContext<Show>(() => undefined);

export function useToast(): Show {
  return useContext(ToastContext);
}

function Toast({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDone(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item, onDone]);
  return (
    <div className={styles.toast}>
      <span>{item.message}</span>
      {item.action ? (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            item.action?.run();
            onDone(item.id);
          }}
        >
          {item.action.label}
        </button>
      ) : null}
    </div>
  );
}

/** Notifications brèves, annoncées aux technologies d'assistance (aria-live). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const remove = useCallback(
    (id: number) => setItems((list) => list.filter((t) => t.id !== id)),
    [],
  );
  const show = useCallback<Show>((message, options = {}) => {
    const id = next.current++;
    setItems((list) => [
      ...list.slice(-2),
      { id, message, action: options.action, duration: options.duration ?? 5000 },
    ]);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {items.map((item) => (
          <Toast key={item.id} item={item} onDone={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
