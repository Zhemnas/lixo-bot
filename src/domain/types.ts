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
  /** Saldo de turnos (define a fila). Pode ser negativo. */
  balance: number;
  /** Distância para a moda guardada ao sair de férias (só para quem está de férias). */
  vacationOffset: number | null;
}

/** Situação do chat privado com o bot (necessário para o lembrete da véspera). */
export type PrivateChatStatus = 'ok' | 'bloqueado' | 'desconhecido';

export interface Settings {
  activeWeekdays: Weekday[];
  holidays: ISODate[];
  announceTime: string; // HH:MM
  deadlineTime: string; // HH:MM
  reminderEnabled: boolean;
  reminderTime: string; // HH:MM
  endOfDayTime: string; // HH:MM
  lateCallGraceMinutes: number;
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
  /** Quem recebeu o +1 de saldo por este dia (deve ser quem efetivamente ficou com ele). */
  creditedId: number | null;
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

export type BalanceKind =
  | 'dia' // +1: ficou com o dia
  | 'dia_estorno' // -1: o dia passou para outra pessoa (ou foi desfeito)
  | 'ajuste' // manual, com motivo
  | 'nivelamento' // subtração da moda
  | 'entrada' // participante novo (saldo 0)
  | 'reativacao' // volta de desligado (saldo 0)
  | 'ferias_saida' // offset guardado (delta 0)
  | 'ferias_volta' // saldo = offset guardado
  | 'ferias_descartado' // férias -> desligado: offset descartado
  | 'migracao';

export interface BalanceEntry {
  id: number;
  participantId: number;
  refDate: ISODate;
  delta: number;
  balanceAfter: number;
  kind: BalanceKind;
  reason: string;
  actor: string;
  createdAt: string;
}

export interface RebaseRecord {
  id: number;
  ts: string;
  refDate: ISODate;
  mode: number;
  reason: string;
  actor: string;
  detail: { name: string; before: number; after: number }[];
}
