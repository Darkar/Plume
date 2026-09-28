// Prépare la description OpenAPI pour le scan ZAP authentifié : URL absolue du serveur, et
// retrait des routes qui fermeraient la session du scan (ZAP les appellerait comme les autres).
import { readFileSync, writeFileSync } from 'node:fs';

// Exemples de valeur du paramètre {id} : « préfixe=valeur » pour les chemins qui commencent par
// ce préfixe, « méthode chemin=valeur » pour une opération précise (prioritaire).
const [input, output, base, ...examples] = process.argv.slice(2);
if (!input || !output || !base) {
  console.error('Usage : node scripts/zap-openapi.mjs <openapi.json> <sortie.json> <https://hôte>');
  process.exit(64);
}
const EXCLUDED = ['/auth/logout', '/auth/logout-all'];

// Script de CI : chemins passés en argument par le workflow.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const spec = JSON.parse(readFileSync(input, 'utf8'));
spec.servers = [{ url: `${base.replace(/\/$/, '')}/api/v1` }];
for (const path of EXCLUDED) delete spec.paths[path];
const rules = examples.map((e) => {
  const at = e.lastIndexOf('=');
  return [e.slice(0, at), e.slice(at + 1)];
});
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    const exact = rules.find(([key]) => key === `${method} ${path}`);
    const match = exact ?? rules.find(([key]) => !key.includes(' ') && path.startsWith(key));
    if (!match) continue;
    for (const param of operation.parameters ?? []) {
      if (param.in === 'path' && param.name === 'id') {
        param.example = match[1];
        param.schema = { ...param.schema, example: match[1] };
      }
    }
  }
}
// eslint-disable-next-line security/detect-non-literal-fs-filename
writeFileSync(output, JSON.stringify(spec, null, 2));
console.log(
  `${Object.keys(spec.paths).length} chemins à analyser (exclus : ${EXCLUDED.join(', ')}).`,
);
