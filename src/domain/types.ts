import type { ISODate, Weekday } from './dates.js';

export type ParticipantStatus = 'ativo' | 'ferias' | 'desligado';
export const PARTICIPANT_STATUSES: ParticipantStatus[] = ['ativo', 'ferias', 'desligado'];

export interface Participant {
  id: number;
  name: string;
  status: ParticipantStatus;
  position: number;
  /** user id numérico do Telegram (como string). */
  telegramUserId: string | null;
  /** @username (sem @), apenas para exibição. */
  telegramUsername: string | null;
  /** Nome no Telegram, apenas para exibição. */
  telegramName: string | null;
}

/** Situação do chat privado com o bot (necessário para o lembrete da véspera). */
export type PrivateChatStatus = 'ok' | 'bloqueado' | 'desconhecido';

export interface PointValues {
  ownTurn: number;
  cover: number;
  covered: number;
  reportedAbsence: number;
}

export interface Settings {
  activeWeekdays: Weekday[];
  holidays: ISODate[];
  announceTime: string; // HH:MM
  deadlineTime: string; // HH:MM
  reminderEnabled: boolean;
  reminderTime: string; // HH:MM
  endOfDayTime: string; // HH:MM
  lateCallGraceMinutes: number;
  points: PointValues;
  groupId: string | null;
  groupName: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  activeWeekdays: [2, 3, 4],
  holidays: [],
  announceTime: '09:00',
  deadlineTime: '16:00',
  reminderEnabled: true,
  reminderTime: '18:00',
  endOfDayTime: '23:59',
  lateCallGraceMinutes: 30,
  points: { ownTurn: 1, cover: 3, covered: 0, reportedAbsence: -1 },
  groupId: null,
  groupName: null,
};

export type DayStatus = 'aberto' | 'chamada' | 'fechado';
export type CallReason = 'naoposso' | 'faltou';

export interface DayRecord {
  date: ISODate;
  originalId: number;
  holderId: number | null;
  status: DayStatus;
  announcedAt: string | null;
  callReason: CallReason | null;
  callAbsenteeId: number | null;
  callOpenedAt: string | null;
  callDeadline: string | null;
  doneAt: string | null;
  finalizedAt: string | null;
  /** Mensagem que carrega os botões do dia (Não posso / Faltou / Feito). */
  actionsChatId: string | null;
  actionsMessageId: number | null;
  /** Mensagem da chamada de cobertura (botão Eu pego). */
  callChatId: string | null;
  callMessageId: number | null;
}

export type CoverageMode = 'voluntario' | 'automatico';

export interface Coverage {
  id: number;
  date: ISODate;
  coveredId: number;
  covererId: number;
  mode: CoverageMode;
  reason: CallReason;
  status: 'ativa' | 'cancelada';
  createdAt: string;
}

export type PointKind = 'turno' | 'cobertura' | 'coberto' | 'falta' | 'ajuste';

export interface PointEntry {
  id: number;
  participantId: number;
  refDate: ISODate;
  delta: number;
  kind: PointKind;
  reason: string;
  actor: string;
  createdAt: string;
}
