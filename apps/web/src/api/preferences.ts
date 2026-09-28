import { api } from './client';

export type Theme = 'auto' | 'light' | 'dark';
export type Accent = 'indigo' | 'blue' | 'teal' | 'green' | 'orange' | 'rose';
export type Density = 'comfortable' | 'compact';

export interface Preferences {
  theme: Theme;
  accent: Accent;
  density: Density;
  notifications: { desktop: boolean; sound: boolean; dailyDigest: boolean };
  signatureHtml: string;
  displayName: string | null;
  language: 'auto' | 'fr' | 'en';
  hasAvatar: boolean;
  limits?: { maxAttachmentSize: number; maxUploadTotal: number };
}

export const preferencesKey = ['preferences'] as const;
export const fetchPreferences = () => api<Preferences>('GET', '/me/preferences');
export const updatePreferences = (patch: Partial<Preferences>) =>
  api<Preferences>('PATCH', '/me/preferences', patch);

export const AVATAR_URL = '/api/v1/me/avatar';
export const uploadAvatar = (data: string) => api<void>('PUT', '/me/avatar', { data });
export const removeAvatar = () => api<void>('DELETE', '/me/avatar');
