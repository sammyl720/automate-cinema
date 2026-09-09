import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const manifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  files: z
    .array(
      z.object({
        path: z.string(),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1),
});

async function digest(file: string) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  const info = await lstat(file);
  if (!info.isFile() || bytes !== info.size)
    throw new Error(`Incomplete file read: ${file}`);
  return { bytes, sha256: hash.digest('hex') };
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
    else
      throw new Error(
        `Backup does not follow symbolic links or special files: ${path}`,
      );
  }
  return files.sort();
}

function checkDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok')
      throw new Error('Backup database integrity check failed');
    return db
      .prepare(
        "SELECT data FROM records WHERE kind='asset' AND deleted_at IS NULL",
      )
      .all()
      .map((row) => {
        const asset = z
          .object({ path: z.string() })
          .parse(JSON.parse(String(row.data)));
        return `media/${asset.path}`;
      });
  } finally {
    db.close();
  }
}

export async function verifyBackup(directory: string) {
  const root = await realpath(directory);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
  );
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (
      names.has(file.path) ||
      (file.path !== 'studio.sqlite' && !file.path.startsWith('media/'))
    )
      throw new Error('Invalid backup manifest path');
    names.add(file.path);
    const path = resolve(root, file.path);
    if (!path.startsWith(root + sep) || (await realpath(path)) !== path)
      throw new Error('Unsafe backup path');
    const actual = await digest(path);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error(`Backup checksum mismatch: ${file.path}`);
  }
  if (!names.has('studio.sqlite'))
    throw new Error('Backup database is missing');
  for (const asset of checkDatabase(join(root, 'studio.sqlite'))) {
    if (!names.has(asset))
      throw new Error(`Backup is missing an asset: ${asset}`);
  }
  return {
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
  };
}

// Stop API, worker and demo processes before calling: SQLite snapshots are
// consistent, but media and SQLite do not share a filesystem transaction.
export async function createBackup(
  dataDirectory: string,
  outputDirectory: string,
) {
  const source = await realpath(dataDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const output = await realpath(outputDirectory);
  if (output === source || output.startsWith(source + sep))
    throw new Error('Choose a backup location outside the data directory');
  const temp = await mkdtemp(join(output, '.incomplete-'));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(source, 'studio.sqlite'), { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    const version = db.prepare('PRAGMA data_version').get()?.data_version;
    db.prepare('VACUUM INTO ?').run(join(temp, 'studio.sqlite'));
    const files = [
      { path: 'studio.sqlite', ...(await digest(join(temp, 'studio.sqlite'))) },
    ];
    const mediaRoot = join(source, 'media');
    let media: string[] = [];
    try {
      if (
        !(await lstat(mediaRoot)).isDirectory() ||
        (await realpath(mediaRoot)) !== mediaRoot
      )
        throw new Error('Media directory must be a local directory');
      media = await filesUnder(mediaRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const file of media) {
      const path = relative(source, file).split(sep).join('/');
      const target = join(temp, path);
      await mkdir(dirname(target), { recursive: true });
      const before = await digest(file);
      await copyFile(file, target);
      const copied = await digest(target);
      const after = await digest(file);
      if (
        before.sha256 !== copied.sha256 ||
        before.sha256 !== after.sha256 ||
        before.bytes !== copied.bytes
      )
        throw new Error(`Media changed during backup: ${path}`);
      files.push({ path, ...copied });
    }
    if (version !== db.prepare('PRAGMA data_version').get()?.data_version)
      throw new Error(
        'Studio data changed during backup. Stop all studio processes and retry.',
      );
    db.close();
    db = undefined;
    await writeFile(
      join(temp, 'manifest.json'),
      JSON.stringify(
        { version: 1, createdAt: new Date().toISOString(), files },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    const result = await verifyBackup(temp);
    const destination = join(
      output,
      `studio-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    );
    await rename(temp, destination);
    return { directory: destination, ...result };
  } catch (error) {
    db?.close();
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
