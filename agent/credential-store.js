// Per-account Alpaca credential storage.
// Lives outside agent-config.json so secrets stay out of the file most
// operators copy around when debugging. Phase 2: swap this implementation
// for one backed by Windows DPAPI without changing the public interface.
import fs from 'fs/promises';
import path from 'path';

let _store = {};
let _filePath = null;
let _writeLock = Promise.resolve();
let _loaded = false;

export async function loadCredentialStore(filePath) {
  _filePath = filePath;
  _store = {};
  _loaded = true;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    try {
      _store = JSON.parse(raw);
    } catch (parseErr) {
      throw new Error(`credential store parse failed at ${filePath}: ${parseErr.message}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No file yet — empty store, no write until first setCredentials.
      return;
    }
    throw err;
  }
}

function assertLoaded() {
  if (!_loaded) throw new Error('credential store not loaded — call loadCredentialStore(filePath) first');
}

export function getCredentials(accountId) {
  assertLoaded();
  const entry = _store[accountId];
  if (!entry) return null;
  return { publicKey: entry.publicKey, secretKey: entry.secretKey };
}

export function listAccountIds() {
  assertLoaded();
  return Object.keys(_store);
}

export async function setCredentials(accountId, { publicKey, secretKey }) {
  assertLoaded();
  if (!publicKey || !secretKey) {
    throw new Error('setCredentials requires both publicKey and secretKey');
  }
  _store[accountId] = { publicKey, secretKey };
  await _persist();
}

export async function deleteCredentials(accountId) {
  assertLoaded();
  if (!(accountId in _store)) return;
  delete _store[accountId];
  await _persist();
}

function _persist() {
  // Serialize file writes via the same chained-promise lock pattern config-store uses.
  // The chain captures the CURRENT _store snapshot value at the moment the write
  // actually runs, so concurrent setCredentials calls produce a consistent final state.
  _writeLock = _writeLock.then(async () => {
    await fs.mkdir(path.dirname(_filePath), { recursive: true });
    await fs.writeFile(_filePath, JSON.stringify(_store, null, 2));
  }).catch(err => {
    console.error('credential-store persist error:', err.message);
    throw err;
  });
  return _writeLock;
}

// Test-only: reset internal state. Used by integration tests that re-init.
export function _resetForTests() {
  _store = {};
  _filePath = null;
  _writeLock = Promise.resolve();
  _loaded = false;
}
