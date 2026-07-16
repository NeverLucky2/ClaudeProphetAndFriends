import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

// makeFsIo returns an atomic-write-backed store rooted at rootDir.
export function makeFsIo(rootDir) {
  const dailyDir = path.join(rootDir, 'daily');
  const episodesPath = path.join(rootDir, 'episodes.json');

  async function writeAtomic(file, obj) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await rename(tmp, file); // atomic on same volume
  }
  async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  return {
    readEpisodes: () => readJson(episodesPath, []),
    writeEpisodes: (arr) => writeAtomic(episodesPath, arr),
    dailyExists: async (etDate) => (await readJson(path.join(dailyDir, `${etDate}.json`), null)) !== null,
    writeDaily: (etDate, obj) => writeAtomic(path.join(dailyDir, `${etDate}.json`), obj),
    listDailyDates: async () => {
      try { return (await readdir(dailyDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
  };
}
