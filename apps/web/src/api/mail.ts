import { api } from './client';

export interface Address {
  name: string;
  address: string;
}

export interface Folder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | null;
  total: number;
  unseen: number;
}

export interface MessageSummary {
  id: string;
  folder: string;
  subject: string;
  from: Address[];
  to: Address[];
  date: string | null;
  size: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  keywords: string[];
  hasAttachments: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  previewable: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: Address[];
  replyTo: Address[];
  messageId: string | null;
  attachments: Attachment[];
  remoteImagesPolicy: 'block_by_default' | 'allow';
  blockedRemoteImages: number;
}

export type ListFilter = 'all' | 'unseen' | 'flagged' | 'attachments';

export interface MessagePage {
  messages: MessageSummary[];
  nextCursor: string | null;
  total: number;
}

export const mailKeys = {
  folders: ['folders'] as const,
  messages: (folder: string, filter: ListFilter, q: string, label: string) =>
    ['messages', folder, filter, q, label] as const,
  message: (id: string) => ['message', id] as const,
  labels: ['labels'] as const,
  snoozes: ['snoozes'] as const,
};

export const fetchFolders = () => api<{ folders: Folder[] }>('GET', '/folders');

export function fetchMessages(
  folder: string,
  filter: ListFilter,
  q: string,
  cursor?: string,
  label?: string,
) {
  const params = new URLSearchParams({ folder, filter, limit: '50' });
  if (q) params.set('q', q);
  if (label) params.set('label', label);
  if (cursor) params.set('cursor', cursor);
  return api<MessagePage>('GET', `/messages?${params.toString()}`);
}

export const fetchMessage = (id: string) =>
  api<MessageDetail>('GET', `/messages/${encodeURIComponent(id)}`);

export function bodyUrl(id: string, images: boolean, theme: 'light' | 'dark' = 'light'): string {
  const params = new URLSearchParams({ theme });
  if (images) params.set('images', '1');
  return `/api/v1/messages/${encodeURIComponent(id)}/body?${params.toString()}`;
}

export const attachmentUrl = (id: string, inline = false) =>
  `/api/v1/attachments/${encodeURIComponent(id)}${inline ? '?inline=1' : ''}`;

export interface MoveResult {
  id: string | null;
  folder?: string | null;
  from: string;
}

export const updateMessage = (
  id: string,
  body: { seen?: boolean; flagged?: boolean; labels?: { add?: string[]; remove?: string[] } },
) => api<void>('PATCH', `/messages/${encodeURIComponent(id)}`, body);

export const moveMessage = (id: string, folder: string) =>
  api<MoveResult>('POST', `/messages/${encodeURIComponent(id)}/move`, { folder });

export const archiveMessage = (id: string) =>
  api<MoveResult>('POST', `/messages/${encodeURIComponent(id)}/archive`);

export const junkMessage = (id: string) =>
  api<MoveResult>('POST', `/messages/${encodeURIComponent(id)}/junk`);

export const deleteMessage = (id: string) =>
  api<MoveResult & { permanent: boolean }>('DELETE', `/messages/${encodeURIComponent(id)}`);

export interface OutgoingRecipient {
  name?: string;
  address: string;
}

export interface OutgoingMessage {
  to: OutgoingRecipient[];
  cc: OutgoingRecipient[];
  bcc: OutgoingRecipient[];
  subject: string;
  html: string;
  inReplyTo?: string;
  attachments: { filename: string; contentType: string; data: string }[];
}

export const sendMessage = (message: OutgoingMessage) =>
  api<{ status: 'sent' }>('POST', '/messages/send', message);

export const fetchQuote = (id: string) =>
  api<{ text: string }>('GET', `/messages/${encodeURIComponent(id)}/quote`);

export const fetchLabels = () => api<{ labels: string[] }>('GET', '/labels');
export const deleteLabel = (name: string) =>
  api<{ removed: number }>('DELETE', `/labels/${encodeURIComponent(name)}`);

export interface SnoozeResult {
  id: string;
  snoozeId: string;
  from: string;
  wakeAt: string;
}

export const snoozeMessage = (id: string, until: Date) =>
  api<SnoozeResult>('POST', `/messages/${encodeURIComponent(id)}/snooze`, {
    until: until.toISOString(),
  });

export interface Snooze {
  id: string;
  messageId: string;
  wakeAt: string;
  returnTo: string;
}

export const fetchSnoozes = () => api<{ snoozes: Snooze[] }>('GET', '/snoozes');
export const cancelSnooze = (snoozeId: string) =>
  api<void>('DELETE', `/snoozes/${encodeURIComponent(snoozeId)}`);
