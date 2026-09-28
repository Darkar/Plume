import type { OutgoingRecipient } from '../api/mail';

const ADDRESS_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/**
 * Analyse une liste saisie : « a@b.fr, Nom <c@d.fr>; e@f.fr ». Renvoie les destinataires
 * valides et les entrées invalides (affichées à l'utilisateur). La validation stricte est faite
 * par le serveur.
 */
export function parseRecipients(input: string): { valid: OutgoingRecipient[]; invalid: string[] } {
  const valid: OutgoingRecipient[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[,;\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = /^(.*)<([^<>]+)>$/.exec(entry);
    const name = match ? (match[1] ?? '').trim().replace(/^"|"$/g, '') : '';
    const address = (match ? (match[2] ?? '') : entry).trim().toLowerCase();
    if (ADDRESS_RE.test(address)) valid.push({ name, address });
    else invalid.push(entry);
  }
  return { valid, invalid };
}

export function formatRecipients(list: { name: string; address: string }[]): string {
  return list.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address)).join(', ');
}
