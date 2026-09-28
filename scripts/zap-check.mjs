// Échoue si un rapport JSON de ZAP contient au moins une alerte de risque élevé (riskcode 3).
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage : node scripts/zap-check.mjs <rapport.json>...');
  process.exit(64);
}

let high = 0;
for (const file of files) {
  // Script de CI : le chemin du rapport est passé en argument par le workflow.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const site of report.site ?? []) {
    for (const alert of site.alerts ?? []) {
      const risk = Number(alert.riskcode);
      const label = ['Info', 'Faible', 'Moyen', 'Élevé'][risk] ?? risk;
      console.log(
        `[${label}] ${alert.pluginid} ${alert.name} (${alert.count ?? '?'} occurrence(s))`,
      );
      if (risk >= 3) high += 1;
    }
  }
}

if (high > 0) {
  console.error(`\n${high} alerte(s) de niveau élevé : échec.`);
  process.exit(1);
}
console.log('\nAucune alerte de niveau élevé.');
