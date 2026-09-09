import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackup, verifyBackup } from '../server/backup';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cinema-backup-test-'));
  const data = join(root, 'data');
  await mkdir(join(data, 'media', 'project'), { recursive: true });
  const db = new DatabaseSync(join(data, 'studio.sqlite'));
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE records(kind TEXT,data TEXT,deleted_at TEXT); INSERT INTO records VALUES(\'project\',\'{"title":"Recovered film"}\',NULL)',
  );
  db.prepare('INSERT INTO records VALUES(?,?,NULL)').run(
    'asset',
    JSON.stringify({ path: 'project/clip.mp4' }),
  );
  await writeFile(join(data, 'media/project/clip.mp4'), 'media fixture');
  await writeFile(join(data, '.env'), 'PRIVATE_TEST_CREDENTIAL');
  return {
    root,
    data,
    db,
    output: join(root, 'backups'),
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

void test('backup captures committed WAL data and media, excludes credentials, and detects corruption', async () => {
  const f = await fixture();
  try {
    const result = await createBackup(f.data, f.output);
    assert.equal(result.files, 2);
    const snapshot = new DatabaseSync(join(result.directory, 'studio.sqlite'), {
      readOnly: true,
    });
    assert.equal(
      snapshot.prepare('SELECT count(*) AS n FROM records').get()?.n,
      2,
    );
    snapshot.close();
    assert.deepEqual((await readdir(result.directory)).sort(), [
      'manifest.json',
      'media',
      'studio.sqlite',
    ]);
    await verifyBackup(result.directory);
    await writeFile(
      join(result.directory, 'media/project/clip.mp4'),
      'changed',
    );
    await assert.rejects(verifyBackup(result.directory), /checksum mismatch/);
    assert.equal(
      await readFile(join(f.data, 'media/project/clip.mp4'), 'utf8'),
      'media fixture',
    );
  } finally {
    await f.close();
  }
});

void test('missing assets fail backup without publishing an incomplete directory', async () => {
  const f = await fixture();
  try {
    await rm(join(f.data, 'media/project/clip.mp4'));
    await assert.rejects(createBackup(f.data, f.output), /missing an asset/);
    assert.deepEqual(await readdir(f.output), []);
    await assert.rejects(
      createBackup(f.data, join(f.data, 'backups')),
      /outside the data/,
    );
  } finally {
    await f.close();
  }
});

void test('backup refuses symlinked media and verification refuses traversal', async () => {
  const f = await fixture();
  try {
    await symlink(join(f.data, '.env'), join(f.data, 'media/secret'));
    await assert.rejects(createBackup(f.data, f.output), /symbolic links/);
    await rm(join(f.data, 'media/secret'));
    const backup = await createBackup(f.data, f.output);
    const file = join(backup.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      files: { path: string }[];
    };
    manifest.files[0].path = 'media/../../outside';
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(verifyBackup(backup.directory), /Unsafe backup path/);
  } finally {
    await f.close();
  }
});
