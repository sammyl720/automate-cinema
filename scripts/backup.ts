import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createBackup, verifyBackup } from '../server/backup';

if (existsSync('.env')) process.loadEnvFile('.env');
try {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      verify: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Stop API, worker and demo processes first.\nnpm run backup -- [--output /backup/folder]\nnpm run backup -- --verify /backup/folder/studio-...\nBackups contain the database and media, not .env credentials.',
    );
  } else if (values.verify) {
    if (values.output) throw new Error('Use --verify or --output, not both');
    console.log('Backup verified:', await verifyBackup(values.verify));
  } else {
    console.log(
      'Creating offline backup. All studio processes must be stopped.',
    );
    console.log(
      'Backup verified:',
      await createBackup(
        process.env.STUDIO_DATA_DIR ?? './data',
        values.output ?? join(homedir(), 'Developer', 'cinema-backups'),
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backup failed');
  process.exitCode = 1;
}
