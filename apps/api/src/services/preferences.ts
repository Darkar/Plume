import { schema, type DbHandle, type Preferences } from '@plume/db';
import { headerSafe, sanitizeOutgoingHtml } from '@plume/mail';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

export const ACCENTS = ['indigo', 'blue', 'teal', 'green', 'orange', 'rose'] as const;

export const preferencesPatch = z.strictObject({
  theme: z.enum(['auto', 'light', 'dark']).optional(),
  accent: z.enum(ACCENTS).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  language: z.enum(['auto', 'fr', 'en']).optional(),
  notifications: z
    .strictObject({
      desktop: z.boolean().optional(),
      sound: z.boolean().optional(),
      dailyDigest: z.boolean().optional(),
    })
    .optional(),
  signatureHtml: z.string().max(20_000).optional(),
  displayName: z.string().trim().max(100).nullable().optional(),
});

export type PreferencesPatch = z.infer<typeof preferencesPatch>;

export interface PreferencesView {
  theme: Preferences['theme'];
  accent: Preferences['accent'];
  density: Preferences['density'];
  language: Preferences['language'];
  notifications: Preferences['notifications'];
  hasAvatar: boolean;
  signatureHtml: string;
  displayName: string | null;
}

const DEFAULTS = {
  theme: 'auto',
  accent: 'indigo',
  density: 'comfortable',
  language: 'auto',
  notifications: { desktop: false, sound: false, dailyDigest: false },
  signatureHtml: '',
} as const;

export class PreferencesService {
  constructor(private readonly db: DbHandle['db']) {}

  async get(userId: string): Promise<PreferencesView> {
    const [row] = await this.db
      .select()
      .from(schema.preferences)
      .where(eq(schema.preferences.userId, userId));
    const [avatar] = await this.db
      .select({ userId: schema.avatars.userId })
      .from(schema.avatars)
      .where(eq(schema.avatars.userId, userId));
    const [user] = await this.db
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return {
      theme: row?.theme ?? DEFAULTS.theme,
      accent: row?.accent ?? DEFAULTS.accent,
      density: row?.density ?? DEFAULTS.density,
      language: row?.language ?? DEFAULTS.language,
      notifications: row?.notifications ?? { ...DEFAULTS.notifications },
      signatureHtml: row?.signatureHtml ?? DEFAULTS.signatureHtml,
      displayName: user?.displayName ?? null,
      hasAvatar: Boolean(avatar),
    };
  }

  /**
   * N'écrit que les champs fournis (deux modifications simultanées ne s'écrasent pas) ; les
   * notifications sont fusionnées en SQL (`||` sur jsonb).
   */
  async update(userId: string, patch: PreferencesPatch): Promise<PreferencesView> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.theme !== undefined) set.theme = patch.theme;
    if (patch.accent !== undefined) set.accent = patch.accent;
    if (patch.density !== undefined) set.density = patch.density;
    if (patch.language !== undefined) set.language = patch.language;
    // La signature est du HTML fourni par l'utilisateur : nettoyée avant enregistrement.
    if (patch.signatureHtml !== undefined)
      set.signatureHtml = sanitizeOutgoingHtml(patch.signatureHtml);
    const notifications = patch.notifications
      ? Object.fromEntries(Object.entries(patch.notifications).filter(([, v]) => v !== undefined))
      : null;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.preferences)
        .values({
          userId,
          ...(set as object),
          notifications: { ...DEFAULTS.notifications, ...(notifications ?? {}) },
        })
        .onConflictDoUpdate({
          target: schema.preferences.userId,
          set: {
            ...set,
            ...(notifications
              ? {
                  notifications: sql`${schema.preferences.notifications} || ${JSON.stringify(notifications)}::jsonb`,
                }
              : {}),
          },
        });
      if (patch.displayName !== undefined) {
        const name = patch.displayName ? headerSafe(patch.displayName, 100) : null;
        await tx
          .update(schema.users)
          .set({ displayName: name || null })
          .where(eq(schema.users.id, userId));
      }
    });
    return this.get(userId);
  }

  // --- Photo de profil ------------------------------------------------------------------------

  async getAvatar(userId: string): Promise<{ image: Buffer; updatedAt: Date } | null> {
    const [row] = await this.db
      .select({ image: schema.avatars.image, updatedAt: schema.avatars.updatedAt })
      .from(schema.avatars)
      .where(eq(schema.avatars.userId, userId));
    return row ?? null;
  }

  async setAvatar(userId: string, image: Buffer): Promise<void> {
    await this.db
      .insert(schema.avatars)
      .values({ userId, image, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.avatars.userId,
        set: { image, updatedAt: new Date() },
      });
  }

  async removeAvatar(userId: string): Promise<void> {
    await this.db.delete(schema.avatars).where(eq(schema.avatars.userId, userId));
  }
}
