import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { mailKeys } from '../api/mail';
import { preferencesKey, type Preferences } from '../api/preferences';
import { useT } from '../i18n';

/** Court signal sonore (Web Audio : aucun fichier chargé). */
function playChime(): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.4);
    oscillator.onended = () => void context.close();
  } catch {
    // Son indisponible (politique d'autolecture…) : sans conséquence.
  }
}

/**
 * Mises à jour en temps réel (SSE) : rafraîchit la liste et les compteurs ; à l'arrivée de
 * nouveaux messages, notification du bureau et son selon les préférences. La notification
 * n'indique que le nombre de messages (ni expéditeur, ni objet).
 */
export function useMailEvents(enabled = true): void {
  const queryClient = useQueryClient();
  const t = useT();
  const translate = useRef(t);
  translate.current = t;

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/v1/events');
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: mailKeys.folders });
    };
    const onMailbox = (event: MessageEvent<string>) => {
      refresh();
      let arrived = 0;
      try {
        const data = JSON.parse(event.data) as { exists?: number; previous?: number };
        if (typeof data.exists === 'number' && typeof data.previous === 'number') {
          arrived = data.exists - data.previous;
        }
      } catch {
        arrived = 0;
      }
      if (arrived <= 0) return;
      const prefs = queryClient.getQueryData<Preferences>(preferencesKey);
      if (prefs?.notifications.sound) playChime();
      if (
        prefs?.notifications.desktop &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        document.visibilityState !== 'visible'
      ) {
        const notification = new Notification('Plume', {
          body: translate.current('settings.notifications.newMail', { count: arrived }),
          tag: 'plume-new-mail',
          icon: '/favicon.svg',
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      }
    };
    source.addEventListener('mailbox', onMailbox);
    source.addEventListener('flags', refresh);
    return () => source.close();
  }, [enabled, queryClient]);
}
