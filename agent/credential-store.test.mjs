import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function withTempFile(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-store-'));
  const file = path.join(dir, 'accounts-secrets.json');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('loadCredentialStore with no file: empty store, no write happens', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    assert.equal(store.getCredentials('anything'), null);
    assert.deepEqual(store.listAccountIds(), []);
    // Should NOT have created the file just from a read
    await assert.rejects(fs.access(file), /ENOENT/);
  });
});

test('loadCredentialStore with malformed JSON: throws loud', async () => {
  await withTempFile(async (file) => {
    await fs.writeFile(file, '{not valid json');
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await assert.rejects(
      () => store.loadCredentialStore(file),
      /credential store.*parse|JSON/i
    );
  });
});

test('setCredentials then getCredentials round-trips', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    await store.setCredentials('acct-1', { publicKey: 'PK1', secretKey: 'SK1' });
    assert.deepEqual(store.getCredentials('acct-1'), { publicKey: 'PK1', secretKey: 'SK1' });
  });
});

test('setCredentials twice for same id: second overwrites (rotation)', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    await store.setCredentials('acct-1', { publicKey: 'PK1', secretKey: 'SK1' });
    await store.setCredentials('acct-1', { publicKey: 'PK2', secretKey: 'SK2' });
    assert.deepEqual(store.getCredentials('acct-1'), { publicKey: 'PK2', secretKey: 'SK2' });
  });
});

test('deleteCredentials removes entry', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    await store.setCredentials('acct-1', { publicKey: 'PK', secretKey: 'SK' });
    await store.deleteCredentials('acct-1');
    assert.equal(store.getCredentials('acct-1'), null);
  });
});

test('listAccountIds returns current keys', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    await store.setCredentials('a', { publicKey: 'P', secretKey: 'S' });
    await store.setCredentials('b', { publicKey: 'P', secretKey: 'S' });
    assert.deepEqual(store.listAccountIds().sort(), ['a', 'b']);
  });
});

test('concurrent setCredentials calls serialize (final state = last write)', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    // Kick off 5 writes in parallel; the last to be queued wins.
    const writes = [];
    for (let i = 0; i < 5; i++) {
      writes.push(store.setCredentials('a', { publicKey: 'PK' + i, secretKey: 'SK' + i }));
    }
    await Promise.all(writes);
    // The file on disk should match the in-memory state — no torn write
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
    assert.deepEqual(onDisk['a'], store.getCredentials('a'));
  });
});

test('persistence: load → set → re-load round-trips through disk', async () => {
  await withTempFile(async (file) => {
    const store1 = await import('./credential-store.js?cachebust=A' + Date.now());
    await store1.loadCredentialStore(file);
    await store1.setCredentials('acct-1', { publicKey: 'PK', secretKey: 'SK' });

    // Fresh module load reading the same file
    const store2 = await import('./credential-store.js?cachebust=B' + Date.now());
    await store2.loadCredentialStore(file);
    assert.deepEqual(store2.getCredentials('acct-1'), { publicKey: 'PK', secretKey: 'SK' });
  });
});

test('write-lock recovery: failed write does not poison lock for subsequent writes', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=C' + Date.now());
    await store.loadCredentialStore(file);

    // First write: succeed (establishes file on disk)
    await store.setCredentials('acct-1', { publicKey: 'PK1', secretKey: 'SK1' });

    // Second write: force a failure by making writeFile throw once
    const originalWriteFile = fs.writeFile;
    let callCount = 0;
    mock.method(fs, 'writeFile', async (...args) => {
      callCount++;
      if (callCount === 1) throw new Error('simulated disk error');
      return originalWriteFile(...args);
    });

    // This write should reject, but not poison the lock
    await assert.rejects(
      () => store.setCredentials('acct-1', { publicKey: 'PK2', secretKey: 'SK2' }),
      /simulated disk error/
    );

    // Restore real writeFile
    mock.restoreAll();

    // Third write: lock must have recovered — this should succeed
    await store.setCredentials('acct-1', { publicKey: 'PK3', secretKey: 'SK3' });
    assert.deepEqual(store.getCredentials('acct-1'), { publicKey: 'PK3', secretKey: 'SK3' });
  });
});
