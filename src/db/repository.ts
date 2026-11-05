import type { Database as DB } from 'better-sqlite3';
import {
  DEFAULT_SETTINGS,
  type CallReason,
  type Coverage,
  type CoverageMode,
  type DayRecord,
  type DayStatus,
  type Participant,
  type ParticipantStatus,
  type PointEntry,
  type PointKind,
  type Settings,
} from '../domain/types.js';

interface ParticipantRow {
  id: number;
  name: string;
  status: ParticipantStatus;
  position: number;
  telegram_user_id: string | null;
  telegram_username: string | null;
  telegram_name: string | null;
}

interface DayRow {
  date: string;
  original_id: number;
  holder_id: number | null;
  status: DayStatus;
  announced_at: string | null;
  call_reason: CallReason | null;
  call_absentee_id: number | null;
  call_opened_at: string | null;
  call_deadline: string | null;
  done_at: string | null;
  finalized_at: string | null;
  actions_chat_id: string | null;
  actions_message_id: number | null;
  call_chat_id: string | null;
  call_message_id: number | null;
}

interface CoverageRow {
  id: number;
  date: string;
  covered_id: number;
  coverer_id: number;
  mode: CoverageMode;
  reason: CallReason;
  status: 'ativa' | 'cancelada';
  created_at: string;
}

interface PointRow {
  id: number;
  participant_id: number;
  ref_date: string;
  delta: number;
  kind: PointKind;
  reason: string;
  actor: string;
  created_at: string;
}

const toParticipant = (r: ParticipantRow): Participant => ({
  id: r.id,
  name: r.name,
  status: r.status,
  position: r.position,
  telegramUserId: r.telegram_user_id,
  telegramUsername: r.telegram_username,
  telegramName: r.telegram_name,
});

const toDay = (r: DayRow): DayRecord => ({
  date: r.date,
  originalId: r.original_id,
  holderId: r.holder_id,
  status: r.status,
  announcedAt: r.announced_at,
  callReason: r.call_reason,
  callAbsenteeId: r.call_absentee_id,
  callOpenedAt: r.call_opened_at,
  callDeadline: r.call_deadline,
  doneAt: r.done_at,
  finalizedAt: r.finalized_at,
  actionsChatId: r.actions_chat_id,
  actionsMessageId: r.actions_message_id,
  callChatId: r.call_chat_id,
  callMessageId: r.call_message_id,
});

const toCoverage = (r: CoverageRow): Coverage => ({
  id: r.id,
  date: r.date,
  coveredId: r.covered_id,
  covererId: r.coverer_id,
  mode: r.mode,
  reason: r.reason,
  status: r.status,
  createdAt: r.created_at,
});

const toPoint = (r: PointRow): PointEntry => ({
  id: r.id,
  participantId: r.participant_id,
  refDate: r.ref_date,
  delta: r.delta,
  kind: r.kind,
  reason: r.reason,
  actor: r.actor,
  createdAt: r.created_at,
});

export interface ScoreRow {
  participantId: number;
  name: string;
  status: ParticipantStatus;
  month: number;
  total: number;
}

export interface DebtRow {
  covererId: number;
  covererName: string;
  coveredId: number;
  coveredName: string;
  count: number;
}

/** Acesso a dados. Sem regras de negócio aqui. */
export class Repository {
  constructor(readonly db: DB) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------- settings ----------
  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const s: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS) as unknown as Record<
      string,
      unknown
    >;
    for (const { key, value } of rows) {
      if (key in s) s[key] = JSON.parse(value);
    }
    const settings = s as unknown as Settings;
    settings.points = { ...DEFAULT_SETTINGS.points, ...settings.points };
    return settings;
  }

  saveSettings(partial: Partial<Settings>): void {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.transaction(() => {
      for (const [k, v] of Object.entries(partial)) {
        if (v !== undefined) stmt.run(k, JSON.stringify(v));
      }
    });
  }

  // ---------- state ----------
  getState(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  // ---------- participants ----------
  listParticipants(): Participant[] {
    return (
      this.db.prepare('SELECT * FROM participants ORDER BY position, id').all() as ParticipantRow[]
    ).map(toParticipant);
  }

  getParticipant(id: number): Participant | null {
    const r = this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as
      | ParticipantRow
      | undefined;
    return r ? toParticipant(r) : null;
  }

  findParticipantByTelegramId(userId: string): Participant | null {
    const r = this.db.prepare('SELECT * FROM participants WHERE telegram_user_id = ?').get(userId) as
      | ParticipantRow
      | undefined;
    return r ? toParticipant(r) : null;
  }

  addParticipant(name: string): Participant {
    const max = (
      this.db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM participants').get() as {
        m: number;
      }
    ).m;
    const info = this.db
      .prepare('INSERT INTO participants (name, position) VALUES (?, ?)')
      .run(name, max + 1);
    return this.getParticipant(Number(info.lastInsertRowid))!;
  }

  setParticipantStatus(id: number, status: ParticipantStatus): void {
    this.db.prepare('UPDATE participants SET status = ? WHERE id = ?').run(status, id);
  }

  renameParticipant(id: number, name: string): void {
    this.db.prepare('UPDATE participants SET name = ? WHERE id = ?').run(name, id);
  }

  setParticipantTelegram(
    id: number,
    userId: string | null,
    username: string | null,
    displayName: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE participants SET telegram_user_id = ?, telegram_username = ?, telegram_name = ? WHERE id = ?',
      )
      .run(userId, userId ? username : null, userId ? displayName : null, id);
  }

  /** Reescreve as posições na ordem dada (1..n). */
  reorder(idsInOrder: number[]): void {
    const stmt = this.db.prepare('UPDATE participants SET position = ? WHERE id = ?');
    this.transaction(() => idsInOrder.forEach((id, i) => stmt.run(i + 1, id)));
  }

  // ---------- days ----------
  getDay(date: string): DayRecord | null {
    const r = this.db.prepare('SELECT * FROM days WHERE date = ?').get(date) as DayRow | undefined;
    return r ? toDay(r) : null;
  }

  insertDay(date: string, participantId: number): void {
    this.db
      .prepare('INSERT INTO days (date, original_id, holder_id) VALUES (?, ?, ?)')
      .run(date, participantId, participantId);
  }

  updateDay(date: string, patch: Partial<Omit<DayRecord, 'date'>>): void {
    const map: Record<string, string> = {
      originalId: 'original_id',
      holderId: 'holder_id',
      status: 'status',
      announcedAt: 'announced_at',
      callReason: 'call_reason',
      callAbsenteeId: 'call_absentee_id',
      callOpenedAt: 'call_opened_at',
      callDeadline: 'call_deadline',
      doneAt: 'done_at',
      finalizedAt: 'finalized_at',
      actionsChatId: 'actions_chat_id',
      actionsMessageId: 'actions_message_id',
      callChatId: 'call_chat_id',
      callMessageId: 'call_message_id',
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${map[k]} = ?`).join(', ');
    this.db
      .prepare(`UPDATE days SET ${sets} WHERE date = ?`)
      .run(...entries.map(([, v]) => v as string | number | null), date);
  }

  listUnfinalizedDaysBefore(date: string): DayRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM days WHERE finalized_at IS NULL AND date < ? ORDER BY date')
        .all(date) as DayRow[]
    ).map(toDay);
  }

  listDays(limit: number): DayRecord[] {
    return (
      this.db.prepare('SELECT * FROM days ORDER BY date DESC LIMIT ?').all(limit) as DayRow[]
    ).map(toDay);
  }

  hasAnnouncedDayInMonth(month: string, beforeDate: string): boolean {
    const r = this.db
      .prepare(
        "SELECT 1 FROM days WHERE substr(date,1,7) = ? AND date < ? AND announced_at IS NOT NULL LIMIT 1",
      )
      .get(month, beforeDate);
    return !!r;
  }

  // ---------- coverages ----------
  insertCoverage(c: Omit<Coverage, 'id' | 'status'>): void {
    this.db
      .prepare(
        'INSERT INTO coverages (date, covered_id, coverer_id, mode, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(c.date, c.coveredId, c.covererId, c.mode, c.reason, c.createdAt);
  }

  cancelActiveCoverageBy(date: string, covererId: number): void {
    this.db
      .prepare(
        "UPDATE coverages SET status = 'cancelada' WHERE date = ? AND coverer_id = ? AND status = 'ativa'",
      )
      .run(date, covererId);
  }

  listCoveragesForDate(date: string): Coverage[] {
    return (
      this.db
        .prepare('SELECT * FROM coverages WHERE date = ? ORDER BY id')
        .all(date) as CoverageRow[]
    ).map(toCoverage);
  }

  listCoverages(limit: number): Coverage[] {
    return (
      this.db
        .prepare('SELECT * FROM coverages ORDER BY date DESC, id DESC LIMIT ?')
        .all(limit) as CoverageRow[]
    ).map(toCoverage);
  }

  debts(): DebtRow[] {
    return this.db
      .prepare(
        `SELECT c.coverer_id AS covererId, a.name AS covererName,
                c.covered_id AS coveredId, b.name AS coveredName, COUNT(*) AS count
           FROM coverages c
           JOIN participants a ON a.id = c.coverer_id
           JOIN participants b ON b.id = c.covered_id
          WHERE c.status = 'ativa'
          GROUP BY c.coverer_id, c.covered_id
          ORDER BY count DESC, covererName`,
      )
      .all() as DebtRow[];
  }

  // ---------- points ----------
  addPoints(e: Omit<PointEntry, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO points (participant_id, ref_date, delta, kind, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(e.participantId, e.refDate, e.delta, e.kind, e.reason, e.actor, e.createdAt);
  }

  listPoints(limit: number): PointEntry[] {
    return (
      this.db.prepare('SELECT * FROM points ORDER BY id DESC LIMIT ?').all(limit) as PointRow[]
    ).map(toPoint);
  }

  scores(month: string): ScoreRow[] {
    return this.db
      .prepare(
        `SELECT p.id AS participantId, p.name, p.status,
                COALESCE(SUM(CASE WHEN substr(x.ref_date,1,7) = ? THEN x.delta END), 0) AS month,
                COALESCE(SUM(x.delta), 0) AS total
           FROM participants p
           LEFT JOIN points x ON x.participant_id = p.id
          GROUP BY p.id
          ORDER BY month DESC, total DESC, p.position`,
      )
      .all(month) as ScoreRow[];
  }

  // ---------- events ----------
  logEvent(ts: string, type: string, detail: unknown): void {
    this.db
      .prepare('INSERT INTO events (ts, type, detail) VALUES (?, ?, ?)')
      .run(ts, type, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  listEvents(limit: number): { id: number; ts: string; type: string; detail: string }[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as {
      id: number;
      ts: string;
      type: string;
      detail: string;
    }[];
  }
}
