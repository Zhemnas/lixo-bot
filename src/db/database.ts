import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { modeOf } from '../domain/rotation.js';

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

/** SQL puro ou função (quando a migração precisa de lógica). Roda dentro de transação. */
type Migration = string | ((db: DB) => void);

const MIGRATIONS: Migration[] = [
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
  // v3: fila por saldo de turnos (substitui o ponteiro round-robin) e fim dos
  // pontos de reconhecimento. Dias e coberturas são preservados.
  migrateToBalance,
];

/**
 * v3. Saldo inicial = dias que cada um efetivamente ficou (holder de dia que não
 * está em chamada), seguido de um nivelamento pela moda dos ativos. Quem está de
 * férias guarda offset = saldo - moda dos ativos. Tabela/config de pontos sai.
 */
function migrateToBalance(db: DB): void {
  db.exec(`
  ALTER TABLE participants ADD COLUMN balance INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE participants ADD COLUMN vacation_offset INTEGER;
  ALTER TABLE days ADD COLUMN credited_id INTEGER REFERENCES participants(id);
  CREATE INDEX idx_days_credited ON days(credited_id);

  CREATE TABLE balance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    ref_date TEXT NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_balance_log_participant ON balance_log(participant_id);

  CREATE TABLE rebases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ref_date TEXT NOT NULL,
    mode INTEGER NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail TEXT NOT NULL
  );

  UPDATE days SET credited_id = CASE WHEN status = 'chamada' THEN NULL ELSE holder_id END;

  DROP TABLE points;
  DELETE FROM settings WHERE key = 'points';
  DELETE FROM state WHERE key = 'last_assigned_id' OR key LIKE 'ranking_posted:%';
  `);

  const ts = new Date().toISOString();
  const refDate = ts.slice(0, 10);
  const people = db
    .prepare(
      `SELECT p.id, p.name, p.status,
              (SELECT COUNT(*) FROM days d WHERE d.credited_id = p.id) AS days
         FROM participants p ORDER BY p.position, p.id`,
    )
    .all() as { id: number; name: string; status: string; days: number }[];
  const mode = modeOf(people.filter((p) => p.status === 'ativo').map((p) => p.days));

  const setBal = db.prepare('UPDATE participants SET balance = ?, vacation_offset = ? WHERE id = ?');
  const log = db.prepare(
    `INSERT INTO balance_log (participant_id, ref_date, delta, balance_after, kind, reason, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'migracao', ?)`,
  );
  const detail: { name: string; before: number; after: number }[] = [];
  for (const p of people) {
    if (p.days !== 0) log.run(p.id, refDate, p.days, p.days, 'migracao', `Saldo inicial: ${p.days} dia(s) já recolhido(s)`, ts);
    if (p.status === 'ativo') {
      setBal.run(p.days - mode, null, p.id);
      detail.push({ name: p.name, before: p.days, after: p.days - mode });
      if (mode !== 0) log.run(p.id, refDate, -mode, p.days - mode, 'nivelamento', `Nivelamento (migração): moda ${mode}`, ts);
    } else {
      // Férias: guarda a distância para a moda; desligado: saldo irrelevante (volta com 0).
      setBal.run(p.days, p.status === 'ferias' ? p.days - mode : null, p.id);
    }
  }
  db.prepare(
    "INSERT INTO rebases (ts, ref_date, mode, reason, actor, detail) VALUES (?, ?, ?, 'migração para saldo de turnos', 'migracao', ?)",
  ).run(ts, refDate, mode, JSON.stringify(detail));
}

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
        const m = MIGRATIONS[v]!;
        if (typeof m === 'string') db.exec(m);
        else m(db);
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
