/** Échappement HTML pour insérer du texte (citation, réponse rapide) dans l'éditeur. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function textToHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line ? escapeHtml(line) : '<br>'))
    .map((line) => `<div>${line}</div>`)
    .join('');
}
