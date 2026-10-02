import { attachmentUrl, fetchDraftBody, type MessageDetail } from '../api/mail';
import { useCompose, type PendingFile } from './ComposeContext';
import { formatRecipients } from './recipients';

/** Contenu d'un fichier en base64 (sans le préfixe « data: »). */
export function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('lecture impossible'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Reprend un brouillon dans la fenêtre de rédaction : destinataires, objet, corps (nettoyé par
 * le serveur) et pièces jointes. Enregistrer le remplace ; l'envoyer le supprime.
 */
export function useResumeDraft() {
  const compose = useCompose();
  return async (message: MessageDetail) => {
    const { html } = await fetchDraftBody(message.id);
    const attachments: PendingFile[] = await Promise.all(
      message.attachments
        .filter((a) => !a.inline)
        .map(async (a) => {
          const response = await fetch(attachmentUrl(a.id), { credentials: 'same-origin' });
          if (!response.ok) throw new Error('attachment_unavailable');
          const blob = await response.blob();
          return {
            filename: a.filename,
            contentType: a.contentType,
            size: blob.size,
            data: await readAsBase64(blob),
          };
        }),
    );
    compose({
      to: formatRecipients(message.to),
      cc: formatRecipients(message.cc),
      bcc: formatRecipients(message.bcc ?? []),
      subject: message.subject,
      bodyHtml: html,
      draftId: message.id,
      attachments,
      withSignature: false,
    });
  };
}
