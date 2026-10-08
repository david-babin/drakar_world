// Persistence: one SQLite file holding the current world, hourly snapshots and the log of units.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LEGACY_DB } from './constants.js';

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // the database used to be called monde.db: adopt it (and its WAL files) if it sits next to the expected path
  const legacy = path.join(path.dirname(file), LEGACY_DB);
  if (!fs.existsSync(file) && fs.existsSync(legacy)) {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(legacy + ext)) fs.renameSync(legacy + ext, file + ext);
    console.log(`database: ${legacy} → ${file}`);
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, saved_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at INTEGER NOT NULL, tick INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, region INTEGER NOT NULL, tick INTEGER NOT NULL, sigil TEXT NOT NULL, hash TEXT NOT NULL, verified INTEGER NOT NULL, ok INTEGER NOT NULL, ms INTEGER, climate REAL);
  `);
  const q = {
    load: db.prepare('SELECT state FROM world WHERE id = 1'),
    save: db.prepare('INSERT INTO world (id, state, saved_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, saved_at = excluded.saved_at'),
    snap: db.prepare('INSERT INTO snapshots (taken_at, tick, state) VALUES (?, ?, ?)'),
    unit: db.prepare('INSERT INTO units (at, region, tick, sigil, hash, verified, ok, ms, climate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    recent: db.prepare('SELECT at, region, tick, sigil, verified, ok, ms, climate FROM units ORDER BY id DESC LIMIT ?'),
  };
  return {
    db,
    loadState: () => { const row = q.load.get(); return row ? JSON.parse(row.state) : null; },
    saveState: (json, now) => q.save.run(json, now),
    snapshot: (now, tick, json) => q.snap.run(now, tick, json),
    logUnit: (...v) => q.unit.run(...v),
    recentUnits: n => q.recent.all(n),
    close: () => db.close(),
  };
}
