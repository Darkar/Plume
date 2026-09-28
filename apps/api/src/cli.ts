import { readFileSync } from 'node:fs';
import { ConfigError, loadConfig, readSecret, readSecretFile } from '@plume/config';
import { parseMasterKey, SecretBox } from '@plume/crypto';
import { createDb, migrate } from '@plume/db';
import { rotateMasterKey } from './rotate-key.js';
import { commitRotation, initSecretsDir, prepareRotation } from './secrets-dir.js';

const [command, ...args] = process.argv.slice(2);

function usage(): never {
  process.stderr.write(
    [
      'Usage : plume <commande>',
      '',
      'Commandes :',
      '  check-config [chemin]                 Valide le fichier YAML',
      '  migrate                               Applique les migrations de la base',
      '  init-secrets <dossier>                Génère les secrets manquants de la pile Docker',
      '  rotate-key --secrets-dir <dossier>    Rotation de la clé maître du dossier de secrets',
      '  rotate-key --new-key-file <chemin>    Rechiffre les secrets avec la clé maître fournie',
      '  openapi                               Écrit la description OpenAPI sur la sortie standard',
      '',
    ].join('\n'),
  );
  process.exit(64);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function configPath(): string {
  return process.env.PLUME_CONFIG ?? '/etc/plume/plume.yaml';
}

async function run(): Promise<void> {
  switch (command) {
    case 'check-config': {
      const config = loadConfig(args[0] ?? configPath());
      // Les secrets des relais SMTP doivent être lisibles (sans afficher leur contenu).
      for (const domain of config.domains) {
        if (domain.smtp.auth) readSecret(domain.smtp.auth.password);
      }
      process.stdout.write(
        `Configuration valide : ${config.domains.length} domaine(s) autorisé(s).\n`,
      );
      return;
    }
    case 'migrate': {
      const config = loadConfig(configPath());
      const db = createDb(readSecret(config.database), { max: 1 });
      try {
        const applied = await migrate(db.pool);
        process.stdout.write(`${applied.length} migration(s) appliquée(s).\n`);
      } finally {
        await db.close();
      }
      return;
    }
    case 'init-secrets': {
      const dir = args[0];
      if (!dir) usage();
      const { created } = initSecretsDir(dir);
      process.stdout.write(
        created.length > 0
          ? `Secrets générés : ${created.join(', ')}.\n`
          : 'Secrets déjà présents : rien à générer.\n',
      );
      return;
    }
    case 'rotate-key': {
      const secretsDir = option('--secrets-dir');
      const newKeyFile = option('--new-key-file');
      if (!secretsDir && !newKeyFile) usage();
      const config = loadConfig(configPath());
      const keys = secretsDir
        ? prepareRotation(secretsDir)
        : {
            current: readSecretFile(config.security.master_key_file),
            next: readSecretFile(newKeyFile!),
          };
      const current = new SecretBox(parseMasterKey(keys.current));
      const next = new SecretBox(parseMasterKey(keys.next));
      const db = createDb(readSecret(config.database), { max: 1 });
      try {
        const result = await rotateMasterKey(db, current, next);
        if (secretsDir) commitRotation(secretsDir);
        process.stdout.write(
          `Rotation terminée : ${result.credentials} identifiant(s) et ${result.totp} secret(s) TOTP rechiffrés (clé ${next.keyId}).\n` +
            (secretsDir
              ? 'Nouvelle clé en place (l’ancienne est conservée en .previous) : redémarrez api et worker.\n'
              : 'Remplacez maintenant le secret plume_master_key puis redémarrez api et worker.\n'),
        );
      } finally {
        await db.close();
      }
      return;
    }
    case 'openapi': {
      const { buildOpenApi } = await import('./openapi.js');
      const { version } = JSON.parse(
        // Chemin fixe, relatif au module (package.json de l'API).
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      process.stdout.write(`${JSON.stringify(buildOpenApi(version), null, 2)}\n`);
      return;
    }
    default:
      usage();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof ConfigError ? error.message : `Erreur : ${(error as Error).message}`}\n`,
  );
  process.exit(error instanceof ConfigError ? 78 : 1);
});
