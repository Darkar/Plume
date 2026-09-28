import type { DragEvent } from 'react';
import type { MessageSummary } from '../api/mail';

/** Type MIME propre à Plume : seul un message de la liste peut être déposé sur un dossier. */
export const MESSAGE_DRAG_TYPE = 'application/x-plume-message';

export interface DraggedMessage {
  id: string;
  folder: string;
}

export function startMessageDrag(
  event: DragEvent,
  message: Pick<MessageSummary, 'id' | 'folder' | 'subject'>,
): void {
  const payload: DraggedMessage = { id: message.id, folder: message.folder };
  event.dataTransfer.setData(MESSAGE_DRAG_TYPE, JSON.stringify(payload));
  event.dataTransfer.setData('text/plain', message.subject);
  event.dataTransfer.effectAllowed = 'move';
}

export function isMessageDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(MESSAGE_DRAG_TYPE);
}

/** Lit le message déposé ; toute donnée inattendue est ignorée. */
export function readMessageDrop(event: DragEvent): DraggedMessage | null {
  try {
    const value = JSON.parse(event.dataTransfer.getData(MESSAGE_DRAG_TYPE)) as unknown;
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as DraggedMessage).id === 'string' &&
      typeof (value as DraggedMessage).folder === 'string'
    ) {
      return value as DraggedMessage;
    }
  } catch {
    // Données absentes ou illisibles.
  }
  return null;
}
