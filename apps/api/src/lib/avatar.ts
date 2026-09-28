import sharp from 'sharp';

export class AvatarError extends Error {
  constructor() {
    super('invalid_image');
    this.name = 'AvatarError';
  }
}

export const AVATAR_MAX_INPUT = 5 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;

/**
 * Réencode une photo fournie par l'utilisateur : décodage par libvips (formats raster courants
 * uniquement, taille en pixels bornée contre les « bombes » de décompression), orientation EXIF
 * appliquée, recadrage 256 × 256, WebP. Le résultat ne contient **aucune** métadonnée (EXIF,
 * GPS, ICC, XMP) : sharp ne les recopie que sur demande explicite.
 */
export async function reencodeAvatar(input: Buffer): Promise<Buffer> {
  if (input.length === 0 || input.length > AVATAR_MAX_INPUT) throw new AvatarError();
  try {
    const image = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false });
    const { format } = await image.metadata();
    if (!format || !['jpeg', 'png', 'webp', 'gif', 'heif', 'avif', 'tiff'].includes(format)) {
      throw new AvatarError();
    }
    return await image
      .rotate()
      .resize(256, 256, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new AvatarError();
  }
}
