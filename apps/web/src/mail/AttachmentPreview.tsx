import { useEffect, useRef, useState } from 'react';
import { attachmentUrl, type Attachment } from '../api/mail';
import { Button } from '../components/ui';
import { getLocale, useT } from '../i18n';
import styles from './MailPage.module.css';

/**
 * Aperçu d'une pièce jointe, toujours dans un bac à sable :
 * - image : iframe `sandbox=""` (ni scripts, ni même origine) pointant vers l'aperçu servi avec
 *   une CSP « sandbox » ;
 * - PDF : visionneuse pdf.js isolée (`sandbox="allow-scripts"` sans `allow-same-origin`, origine
 *   opaque) à laquelle l'interface transmet uniquement les octets du fichier.
 */
export function AttachmentPreview({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);
  const isPdf = file.contentType === 'application/pdf';

  useEffect(() => {
    const element = dialog.current;
    if (element && typeof element.showModal === 'function' && !element.open) element.showModal();
  }, []);

  useEffect(() => {
    if (!isPdf) return;
    const controller = new AbortController();
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      // Seule notre visionneuse (iframe isolée) peut demander le contenu.
      if (!target || event.source !== target) return;
      if ((event.data as { type?: unknown } | null)?.type !== 'plume:pdf-ready') return;
      fetch(attachmentUrl(file.id, true), { credentials: 'same-origin', signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.arrayBuffer();
        })
        .then((bytes) => {
          // Origine opaque : aucune origine cible nommable ; la cible est vérifiée ci-dessus.
          target.postMessage({ type: 'plume:pdf', bytes, lang: getLocale() }, '*', [bytes]);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    };
    window.addEventListener('message', onMessage);
    return () => {
      controller.abort();
      window.removeEventListener('message', onMessage);
    };
  }, [file.id, isPdf]);

  return (
    <dialog
      ref={dialog}
      className={styles.previewDialog}
      aria-label={t('mail.preview.previewOf', { name: file.filename })}
      onClose={onClose}
      onCancel={onClose}
    >
      <div className={styles.previewDialogHeader}>
        <h2>{file.filename}</h2>
        <Button variant="secondary" onClick={onClose}>
          {t('mail.preview.close')}
        </Button>
      </div>
      {failed ? (
        <p role="alert">{t('mail.preview.previewFailed')}</p>
      ) : (
        <iframe
          ref={frame}
          className={styles.previewFrame}
          title={t('mail.preview.previewOf', { name: file.filename })}
          src={isPdf ? '/viewer/pdf.html' : attachmentUrl(file.id, true)}
          sandbox={isPdf ? 'allow-scripts' : ''}
          referrerPolicy="no-referrer"
        />
      )}
    </dialog>
  );
}
