import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

export const SEED_PARTICIPANTS = [
  'Richard',
  'Scherer',
  'Nicholas',
  'Wellington',
  'Nicolas',
  'Koiti',
  'Kafer',
  'Peralta',
  'Vidal',
];

const MIGRATIONS: string[] = [
  `
  CREATE TABLE participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','ferias','desligado')),
    position INTEGER NOT NULL,
    chat_id TEXT UNIQUE,
    chat_alt_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE days (
    date TEXT PRIMARY KEY,
    original_id INTEGER NOT NULL REFERENCES participants(id),
    holder_id INTEGER REFERENCES participants(id),
    status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','chamada','fechado')),
    announced_at TEXT,
    call_reason TEXT CHECK (call_reason IN ('naoposso','faltou')),
    call_absentee_id INTEGER REFERENCES participants(id),
    call_opened_at TEXT,
    call_deadline TEXT,
    done_at TEXT,
    finalized_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE coverages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL REFERENCES days(date),
    covered_id INTEGER NOT NULL REFERENCES participants(id),
    coverer_id INTEGER NOT NULL REFERENCES participants(id),
    mode TEXT NOT NULL CHECK (mode IN ('voluntario','automatico')),
    reason TEXT NOT NULL CHECK (reason IN ('naoposso','faltou')),
    status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','cancelada')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_coverages_date ON coverages(date);

  CREATE TABLE points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    ref_date TEXT NOT NULL,
    delta INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('turno','cobertura','coberto','falta','ajuste')),
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_points_participant ON points(participant_id);
  CREATE INDEX idx_points_ref_date ON points(ref_date);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  `,
  // v2: WhatsApp -> Telegram. Recria participants (colunas UNIQUE não podem ser
  // removidas com DROP COLUMN) preservando ids, nomes, status e posição; pontos,
  // dias e coberturas não são tocados. Vínculos/grupo do WhatsApp são descartados.
  `
  CREATE TABLE participants_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','ferias','desligado')),
    position INTEGER NOT NULL,
    telegram_user_id TEXT UNIQUE,
    telegram_username TEXT,
    telegram_name TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO participants_new (id, name, status, position, created_at)
    SELECT id, name, status, position, created_at FROM participants;
  DROP TABLE participants;
  ALTER TABLE participants_new RENAME TO participants;

  ALTER TABLE days ADD COLUMN actions_chat_id TEXT;
  ALTER TABLE days ADD COLUMN actions_message_id INTEGER;
  ALTER TABLE days ADD COLUMN call_chat_id TEXT;
  ALTER TABLE days ADD COLUMN call_message_id INTEGER;

  DELETE FROM settings WHERE key IN ('groupId', 'groupName');
  `,
];

export function openDatabase(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, file);
  return db;
}

function migrate(db: DB, file: string): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= MIGRATIONS.length) return;
  if (version > 0) {
    // Cópia de segurança antes de alterar um banco existente.
    const backup = `${file}.pre-v${MIGRATIONS.length}-${Date.now()}.bak`;
    db.prepare('VACUUM INTO ?').run(backup);
  }
  // Recriar tabelas referenciadas exige FKs desligadas (fora de transação).
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = version; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]!);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) throw new Error(`migração v${v + 1} quebrou chaves estrangeiras`);
        db.pragma(`user_version = ${v + 1}`);
        if (v === 0) seed(db);
      })();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seed(db: DB): void {
  const insert = db.prepare('INSERT INTO participants (name, position) VALUES (?, ?)');
  SEED_PARTICIPANTS.forEach((name, i) => insert.run(name, i + 1));
}
