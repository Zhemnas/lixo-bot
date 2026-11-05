/**
 * Orquestra as regras de negócio: escala, chamadas de cobertura, pontuação,
 * comandos, botões e tarefas agendadas. Não conhece o Telegram, só `Messenger`.
 *
 * Toda validação acontece aqui. Comandos de texto e botões passam pelas mesmas
 * ações; muda apenas a apresentação do erro (resposta no grupo vs. toast).
 */
import { randomInt } from 'node:crypto';
import {
  PrivateChatUnavailableError,
  type IncomingAction,
  type IncomingMessage,
  type Keyboard,
  type MessageRef,
  type Messenger,
  type OutgoingMessage,
  type Sender,
} from '../channel/types.js';
import type { Repository } from '../db/repository.js';
import { decodeButton, encodeButton, parseCommand, sameName, type Command } from './commands.js';
import {
  addDays,
  formatHHMM,
  formatShort,
  isActiveDay,
  localNow,
  monthKey,
  nextActiveDays,
  parseHHMM,
  previousMonthKey,
  type ISODate,
} from './dates.js';
import * as msg from './messages.js';
import { escapeHtml } from './messages.js';
import { nextInQueue, predict, sortQueue } from './rotation.js';
import type {
  CallReason,
  DayRecord,
  Participant,
  ParticipantStatus,
  PrivateChatStatus,
  Settings,
} from './types.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface ServiceOptions {
  tz: string;
  now?: () => Date;
  logger?: Logger;
  /** Cooldown (ms) de comandos informativos para evitar flood. */
  infoCooldownMs?: number;
}

export interface UpcomingDay {
  date: ISODate;
  participant: Participant | null;
  /** registro real, se o dia já foi gerado */
  record: DayRecord | null;
}

export interface GroupLinkCode {
  code: string;
  expiresAt: Date;
}

/** Como apresentar o resultado de uma ação (texto no grupo ou toast do botão). */
interface Ctx {
  viaButton: boolean;
  /** mensagem de comando a ser respondida (texto) */
  replyTo: number | null;
  /** mensagem que contém o botão clicado */
  source: MessageRef | null;
  /** toast de sucesso/erro (no texto é no-op) */
  ack(text: string, alert?: boolean): Promise<void>;
}

type Outcome = { ok: true } | { ok: false; error: string };
const OK: Outcome = { ok: true };
const fail = (error: string): Outcome => ({ ok: false, error });

const STATE_LAST_ASSIGNED = 'last_assigned_id';
const STATE_LAST_GENERATED = 'last_generated_date';
const LINK_CODE_TTL_MS = 15 * 60_000;
const LINK_CODE_MAX_ATTEMPTS = 5;

const noopLogger: Logger = { info() {}, warn() {}, error() {} };

export class DutyService {
  private readonly tz: string;
  private readonly now: () => Date;
  private readonly log: Logger;
  private readonly infoCooldownMs: number;
  private readonly lastInfo = new Map<string, number>();
  private ticking = false;
  private linkCode: { code: string; expiresAt: number; attempts: number } | null = null;

  constructor(
    readonly repo: Repository,
    private messenger: Messenger,
    opts: ServiceOptions,
  ) {
    this.tz = opts.tz;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.logger ?? noopLogger;
    this.infoCooldownMs = opts.infoCooldownMs ?? 60_000;
  }

  setMessenger(m: Messenger): void {
    this.messenger = m;
  }

  // ================= helpers =================

  settings(): Settings {
    return this.repo.getSettings();
  }

  local() {
    return localNow(this.now(), this.tz);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private participants(): Participant[] {
    return this.repo.listParticipants();
  }

  private name(id: number | null): string {
    if (id === null) return '?';
    return this.repo.getParticipant(id)?.name ?? `#${id}`;
  }

  /** Nome em HTML, com menção clicável se vinculado. */
  private who(p: Participant | null): string {
    if (!p) return '?';
    return p.telegramUserId ? this.messenger.mention(p.telegramUserId, p.name) : escapeHtml(p.name);
  }

  private lastAssignedId(): number | null {
    const v = this.repo.getState(STATE_LAST_ASSIGNED);
    return v ? Number(v) : null;
  }

  private dayKeyboard(date: ISODate): Keyboard {
    return [
      [
        { text: 'Não posso', data: encodeButton({ type: 'naoposso', date }) },
        { text: 'Faltou', data: encodeButton({ type: 'faltou', date }) },
      ],
      [{ text: 'Feito', data: encodeButton({ type: 'feito', date }) }],
    ];
  }

  private callKeyboard(date: ISODate): Keyboard {
    const pts = this.settings().points.cover;
    return [[{ text: `Eu pego (${pts > 0 ? '+' : ''}${pts})`, data: encodeButton({ type: 'eupego', date }) }]];
  }

  private async say(html: string, opts: { buttons?: Keyboard; replyTo?: number | null } = {}): Promise<MessageRef | null> {
    const groupId = this.settings().groupId;
    if (!groupId || !this.messenger.isReady()) {
      this.log.warn({ text: html.slice(0, 200) }, 'mensagem não enviada: canal indisponível ou grupo não vinculado');
      return null;
    }
    const out: OutgoingMessage = { html };
    if (opts.buttons) out.buttons = opts.buttons;
    if (opts.replyTo) out.replyTo = opts.replyTo;
    try {
      return await this.messenger.send(groupId, out);
    } catch (err) {
      this.log.error({ err }, 'falha ao enviar mensagem ao grupo');
      return null;
    }
  }

  private async safeEdit(ref: MessageRef | null, html: string, buttons?: Keyboard): Promise<boolean> {
    if (!ref || !this.messenger.isReady()) return false;
    try {
      await this.messenger.edit(ref, buttons ? { html, buttons } : { html });
      return true;
    } catch (err) {
      this.log.warn({ err }, 'falha ao editar mensagem');
      return false;
    }
  }

  private async safeClear(ref: MessageRef | null): Promise<void> {
    if (!ref || !this.messenger.isReady()) return;
    try {
      await this.messenger.clearButtons(ref);
    } catch (err) {
      this.log.warn({ err }, 'falha ao remover botões');
    }
  }

  private actionsRef(day: DayRecord | null): MessageRef | null {
    return day?.actionsChatId && day.actionsMessageId ? { chatId: day.actionsChatId, messageId: day.actionsMessageId } : null;
  }

  private callRef(day: DayRecord | null): MessageRef | null {
    return day?.callChatId && day.callMessageId ? { chatId: day.callChatId, messageId: day.callMessageId } : null;
  }

  private setActionsRef(date: ISODate, ref: MessageRef | null): void {
    this.repo.updateDay(date, { actionsChatId: ref?.chatId ?? null, actionsMessageId: ref?.messageId ?? null });
  }

  private setCallRef(date: ISODate, ref: MessageRef | null): void {
    this.repo.updateDay(date, { callChatId: ref?.chatId ?? null, callMessageId: ref?.messageId ?? null });
  }

  private sameRef(a: MessageRef | null, b: MessageRef | null): boolean {
    return !!a && !!b && a.chatId === b.chatId && a.messageId === b.messageId;
  }

  private cooledDown(key: string, ms = this.infoCooldownMs): boolean {
    const now = this.now().getTime();
    const last = this.lastInfo.get(key) ?? 0;
    if (now - last < ms) return false;
    this.lastInfo.set(key, now);
    return true;
  }

  // ================= escala =================

  /**
   * Garante (idempotente) o registro do dia. Só gera dias ativos e apenas para
   * datas >= última data gerada, de forma que reiniciar não escale duas vezes
   * nem reescreva o passado.
   */
  ensureDay(date: ISODate): DayRecord | null {
    const existing = this.repo.getDay(date);
    if (existing) return existing;
    const s = this.settings();
    if (!isActiveDay(date, s)) return null;
    const lastGen = this.repo.getState(STATE_LAST_GENERATED);
    if (lastGen && date < lastGen) return null;

    return this.repo.transaction(() => {
      const again = this.repo.getDay(date);
      if (again) return again;
      const p = nextInQueue(this.participants(), this.lastAssignedId());
      if (!p) return null;
      this.repo.insertDay(date, p.id);
      this.repo.setState(STATE_LAST_ASSIGNED, String(p.id));
      this.repo.setState(STATE_LAST_GENERATED, date);
      this.repo.logEvent(this.iso(), 'escala', { date, participant: p.name });
      return this.repo.getDay(date);
    });
  }

  /** Próximos `count` dias ativos (a partir de hoje), misturando registros reais e previsão. */
  upcoming(count: number, from?: ISODate): UpcomingDay[] {
    const s = this.settings();
    const start = from ?? this.local().date;
    const dates = nextActiveDays(start, count, s);
    const participants = this.participants();
    const byId = new Map(participants.map((p) => [p.id, p]));
    const out: UpcomingDay[] = [];
    const pending: ISODate[] = [];
    for (const d of dates) {
      const rec = this.repo.getDay(d);
      if (rec) out.push({ date: d, record: rec, participant: byId.get(rec.holderId ?? rec.originalId) ?? null });
      else pending.push(d);
    }
    const preds = predict(participants, this.lastAssignedId(), pending);
    for (const p of preds) out.push({ date: p.date, participant: p.participant, record: null });
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ================= tarefas agendadas =================

  /** Executado a cada minuto. Idempotente: pode rodar quantas vezes quiser. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickInner();
    } catch (err) {
      this.log.error({ err }, 'erro no tick');
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    const s = this.settings();
    const { date: today, minutes } = this.local();
    const announceAt = parseHHMM(s.announceTime);
    const endAt = parseHHMM(s.endOfDayTime);

    // 1. Fecha dias anteriores pendentes (bot pode ter ficado desligado).
    for (const d of this.repo.listUnfinalizedDaysBefore(today)) await this.closeDay(d.date, 'catch-up');

    // 2. Aviso do dia.
    if (isActiveDay(today, s) && minutes >= announceAt && minutes < endAt) {
      const day = this.ensureDay(today);
      if (day && !day.announcedAt && day.status !== 'fechado' && this.messenger.isReady() && s.groupId) {
        await this.maybePostMonthlyRanking(today);
        await this.announce(day);
      }
    }

    // 3. Prazo da chamada.
    const day = this.repo.getDay(today);
    if (day && day.status === 'chamada' && day.callDeadline && minutes >= parseHHMM(day.callDeadline)) {
      await this.autoEscalate(today);
    }

    // 4. Lembrete na véspera (privado).
    if (s.reminderEnabled && minutes >= parseHHMM(s.reminderTime)) {
      await this.maybeSendReminder(addDays(today, 1));
    }

    // 5. Fim do dia.
    if (minutes >= endAt) {
      const d = this.repo.getDay(today);
      if (d && !d.finalizedAt) await this.closeDay(today, 'fim-do-dia');
    }
  }

  private async announce(day: DayRecord): Promise<boolean> {
    const holder = this.repo.getParticipant(day.holderId ?? day.originalId);
    const next = this.upcoming(2, addDays(day.date, 1))[0];
    const text = msg.dailyAnnouncement({
      date: day.date,
      holder: this.who(holder),
      next: next?.participant
        ? { date: next.date, name: next.participant.name, isTomorrow: next.date === addDays(day.date, 1) }
        : null,
    });
    const ref = await this.say(text, { buttons: this.dayKeyboard(day.date) });
    if (!ref) return false;
    this.repo.updateDay(day.date, {
      announcedAt: this.iso(),
      actionsChatId: ref.chatId,
      actionsMessageId: ref.messageId,
    });
    return true;
  }

  private async maybePostMonthlyRanking(today: ISODate): Promise<void> {
    const month = monthKey(today);
    const prev = previousMonthKey(month);
    const key = `ranking_posted:${prev}`;
    if (this.repo.getState(key)) return;
    if (this.repo.hasAnnouncedDayInMonth(month, today)) {
      this.repo.setState(key, this.iso());
      return;
    }
    const scores = this.repo.scores(prev);
    if (scores.every((x) => x.month === 0)) {
      this.repo.setState(key, this.iso());
      return;
    }
    const text = msg.rankingText({ title: 'Ranking do mês passado', month: prev, scores, debts: [], showTotal: true });
    if (await this.say(text)) this.repo.setState(key, this.iso());
  }

  private async maybeSendReminder(date: ISODate): Promise<void> {
    const s = this.settings();
    if (!isActiveDay(date, s)) return;
    const key = `reminder_sent:${date}`;
    if (this.repo.getState(key)) return;
    if (!this.messenger.isReady()) return;
    const up = this.upcoming(1, date)[0];
    const p = up?.participant;
    if (!up || up.date !== date || !p) return;
    if (!p.telegramUserId) {
      this.repo.setState(key, 'sem-vinculo');
      return;
    }
    try {
      await this.messenger.sendPrivate(p.telegramUserId, msg.reminderText(date));
      this.setPrivateStatus(p.telegramUserId, 'ok');
      this.repo.setState(key, this.iso());
    } catch (err) {
      if (err instanceof PrivateChatUnavailableError) {
        this.setPrivateStatus(p.telegramUserId, 'bloqueado');
        this.repo.setState(key, 'sem-privado');
        this.log.info({ participant: p.name }, 'lembrete não entregue: pessoa não iniciou o privado com o bot');
      } else {
        this.log.error({ err }, 'falha ao enviar lembrete');
        this.repo.setState(key, 'erro');
      }
    }
  }

  /** Fecha o dia e dá os pontos de quem ficou com ele. Idempotente. */
  finalizeDay(date: ISODate, actor: string): { participantId: number; delta: number } | null {
    const pts = this.settings().points;
    return this.repo.transaction(() => {
      const day = this.repo.getDay(date);
      if (!day || day.finalizedAt) return null;
      let awarded: { participantId: number; delta: number } | null = null;
      if (day.status !== 'chamada' && day.holderId !== null) {
        const own = day.holderId === day.originalId;
        const delta = own ? pts.ownTurn : pts.cover;
        this.repo.addPoints({
          participantId: day.holderId,
          refDate: date,
          delta,
          kind: own ? 'turno' : 'cobertura',
          reason: own ? 'Cumpriu o próprio turno' : `Cobriu ${this.name(day.callAbsenteeId)}`,
          actor,
          createdAt: this.iso(),
        });
        awarded = { participantId: day.holderId, delta };
      } else {
        this.repo.logEvent(this.iso(), 'dia_sem_responsavel', { date });
      }
      this.repo.updateDay(date, { status: 'fechado', finalizedAt: this.iso() });
      this.repo.logEvent(this.iso(), 'dia_fechado', { date, actor, awarded });
      return awarded;
    });
  }

  /** Fecha o dia e tira os botões das mensagens que ainda os têm. */
  private async closeDay(date: ISODate, actor: string): Promise<void> {
    this.finalizeDay(date, actor);
    const day = this.repo.getDay(date);
    const refs = [this.actionsRef(day), this.callRef(day)];
    if (refs.every((r) => !r)) return;
    for (const r of refs) await this.safeClear(r);
    this.setActionsRef(date, null);
    this.setCallRef(date, null);
  }

  // ================= chamada / cobertura =================

  private computeDeadline(): string {
    const s = this.settings();
    const { minutes } = this.local();
    const deadline = parseHHMM(s.deadlineTime);
    const end = parseHHMM(s.endOfDayTime);
    let m = minutes < deadline ? deadline : minutes + s.lateCallGraceMinutes;
    if (m >= end) m = Math.max(minutes, end - 1);
    return formatHHMM(m);
  }

  /** Quem já "saiu" do dia (faltante de alguma chamada ou cobridor que desistiu). */
  private excludedForDay(day: DayRecord): Set<number> {
    const ex = new Set<number>([day.originalId]);
    if (day.callAbsenteeId !== null) ex.add(day.callAbsenteeId);
    for (const c of this.repo.listCoveragesForDate(day.date)) {
      ex.add(c.coveredId);
      if (c.status === 'cancelada') ex.add(c.covererId);
    }
    return ex;
  }

  /** Abre chamada de cobertura. Retorna mensagem de erro (texto puro) ou null em caso de sucesso. */
  openCall(date: ISODate, reason: CallReason, actor: string): string | null {
    const s = this.settings();
    return this.repo.transaction(() => {
      const day = this.repo.getDay(date);
      if (!day) return 'Hoje não tem recolhimento.';
      if (day.status === 'fechado') return 'O dia de hoje já foi encerrado.';
      if (day.status === 'chamada') return `Já existe chamada aberta para cobrir ${this.name(day.callAbsenteeId)}.`;
      const absentee = day.holderId!;
      if (absentee !== day.originalId) this.repo.cancelActiveCoverageBy(date, absentee);
      const delta = reason === 'naoposso' ? s.points.covered : s.points.reportedAbsence;
      this.repo.addPoints({
        participantId: absentee,
        refDate: date,
        delta,
        kind: reason === 'naoposso' ? 'coberto' : 'falta',
        reason: reason === 'naoposso' ? 'Avisou que não pode' : 'Falta reportada por colega',
        actor,
        createdAt: this.iso(),
      });
      this.repo.updateDay(date, {
        status: 'chamada',
        holderId: null,
        callReason: reason,
        callAbsenteeId: absentee,
        callOpenedAt: this.iso(),
        callDeadline: this.computeDeadline(),
      });
      this.repo.logEvent(this.iso(), 'chamada_aberta', { date, reason, absentee: this.name(absentee), actor });
      return null;
    });
  }

  /** Voluntário assume o dia. Retorna erro (texto puro) ou null. Atômico: o primeiro vence. */
  claim(date: ISODate, p: Participant): string | null {
    return this.repo.transaction(() => {
      const day = this.repo.getDay(date);
      if (!day || day.status !== 'chamada') {
        if (day && day.status === 'aberto' && day.holderId !== null && day.holderId !== day.originalId) {
          return day.holderId === p.id ? 'O dia já é seu.' : `${this.name(day.holderId)} já pegou.`;
        }
        return 'Não há chamada aberta agora.';
      }
      if (p.status !== 'ativo') return `${p.name}, você não está ativo na escala.`;
      const ex = this.excludedForDay(day);
      if (ex.has(p.id)) {
        return p.id === day.originalId || p.id === day.callAbsenteeId
          ? `${p.name}, você não pode cobrir o próprio dia.`
          : `${p.name}, você já saiu do dia de hoje.`;
      }
      this.applyCoverage(day, p.id, 'voluntario');
      return null;
    });
  }

  private applyCoverage(day: DayRecord, covererId: number, mode: 'voluntario' | 'automatico'): void {
    this.repo.updateDay(day.date, { status: 'aberto', holderId: covererId });
    this.repo.insertCoverage({
      date: day.date,
      coveredId: day.callAbsenteeId!,
      covererId,
      mode,
      reason: day.callReason!,
      createdAt: this.iso(),
    });
    this.repo.logEvent(this.iso(), 'cobertura', {
      date: day.date,
      coverer: this.name(covererId),
      covered: this.name(day.callAbsenteeId),
      mode,
    });
  }

  async autoEscalate(date: ISODate): Promise<Participant | null> {
    const s = this.settings();
    const chosen = this.repo.transaction(() => {
      const day = this.repo.getDay(date);
      if (!day || day.status !== 'chamada') return null;
      const p = nextInQueue(this.participants(), day.originalId, this.excludedForDay(day));
      if (!p) {
        // Ninguém disponível: deixa a chamada sem prazo para não repetir a cada minuto.
        this.repo.updateDay(date, { callDeadline: null });
        this.repo.logEvent(this.iso(), 'escala_automatica_sem_candidato', { date });
        return { p: null, absentee: day.callAbsenteeId };
      }
      this.applyCoverage(day, p.id, 'automatico');
      return { p, absentee: day.callAbsenteeId };
    });
    if (!chosen) return null;
    if (!chosen.p) {
      await this.say('Ninguém disponível para cobrir hoje. Quem puder, toque em <b>Eu pego</b>.');
      return null;
    }
    const day = this.repo.getDay(date);
    const absentee = this.name(chosen.absentee);
    await this.safeEdit(this.callRef(day), msg.coveredNote({ holder: chosen.p.name, absentee, auto: true }));
    this.setCallRef(date, null);
    const ref = await this.say(
      msg.autoEscalated({ holder: this.who(chosen.p), absentee, coverPoints: s.points.cover }),
      { buttons: this.dayKeyboard(date) },
    );
    this.setActionsRef(date, ref);
    return chosen.p;
  }

  // ================= ações (compartilhadas por texto e botões) =================

  private todayIfActive(): DayRecord | null {
    const today = this.local().date;
    return isActiveDay(today, this.settings()) ? this.ensureDay(today) : this.repo.getDay(today);
  }

  private async actNaoPosso(sender: Participant, ctx: Ctx): Promise<Outcome> {
    const day = this.todayIfActive();
    if (!day) return fail('Hoje não tem recolhimento.');
    if (day.status === 'fechado') return fail('O dia de hoje já foi encerrado.');
    if (day.status === 'chamada') {
      return day.callAbsenteeId === sender.id
        ? fail('Já estou procurando alguém para cobrir. Aguarde um "Eu pego".')
        : fail(`Já existe chamada aberta para cobrir ${this.name(day.callAbsenteeId)}.`);
    }
    if (day.holderId !== sender.id) {
      return fail(`Só ${this.name(day.holderId)} pode usar "Não posso". Se a pessoa faltou, use "Faltou".`);
    }
    return this.startCall(day.date, 'naoposso', sender, ctx);
  }

  private async actFaltou(sender: Participant, targetName: string | null, ctx: Ctx): Promise<Outcome> {
    const day = this.todayIfActive();
    if (!day) return fail('Hoje não tem recolhimento.');
    if (day.status === 'fechado') return fail('O dia de hoje já foi encerrado.');
    if (day.status === 'chamada') return fail(`Já existe chamada aberta para cobrir ${this.name(day.callAbsenteeId)}.`);
    if (targetName) {
      const target = this.participants().find((p) => sameName(p.name, targetName));
      if (!target) return fail(`Não conheço "${targetName}".`);
      if (target.id !== day.holderId) return fail(`Hoje o lixo é com ${this.name(day.holderId)}, não com ${target.name}.`);
    }
    if (sender.id === day.holderId) {
      // Pelo texto, o próprio escalado usar /faltou equivale a "não posso".
      if (ctx.viaButton) return fail('Você é o escalado: use "Não posso".');
      return this.startCall(day.date, 'naoposso', sender, ctx);
    }
    return this.startCall(day.date, 'faltou', sender, ctx);
  }

  private async startCall(date: ISODate, reason: CallReason, sender: Participant, ctx: Ctx): Promise<Outcome> {
    const before = this.repo.getDay(date);
    const err = this.openCall(date, reason, sender.name);
    if (err) return fail(err);
    await ctx.ack(reason === 'naoposso' ? 'Ok, vou procurar quem cubra.' : 'Falta registrada. Abri a chamada.');
    const day = this.repo.getDay(date)!;
    const absentee = this.name(day.callAbsenteeId);
    // A mensagem com os botões do dia perde os botões e passa a mostrar o ocorrido.
    await this.safeEdit(this.actionsRef(before), msg.callClosedNote({ date, absentee, reason, actor: sender.name }));
    this.setActionsRef(date, null);
    const ref = await this.say(
      msg.callOpened({ absentee, coverPoints: this.settings().points.cover, deadline: day.callDeadline ?? '' }),
      { buttons: this.callKeyboard(date), replyTo: ctx.replyTo },
    );
    this.setCallRef(date, ref);
    return OK;
  }

  private async actEuPego(sender: Participant, ctx: Ctx): Promise<Outcome> {
    const today = this.local().date;
    const err = this.claim(today, sender);
    if (err) return fail(err);
    await ctx.ack('Valeu! O dia é seu.');
    const day = this.repo.getDay(today)!;
    const absentee = this.name(day.callAbsenteeId);
    const text = msg.claimed({ holder: this.who(sender), absentee, coverPoints: this.settings().points.cover });
    const call = this.callRef(day);
    if (ctx.viaButton && call && this.sameRef(call, ctx.source)) {
      // Clique no botão: a própria chamada vira o novo aviso, com os botões do dia.
      if (await this.safeEdit(call, text, this.dayKeyboard(today))) {
        this.setActionsRef(today, call);
        this.setCallRef(today, null);
        return OK;
      }
    }
    await this.safeEdit(call, msg.coveredNote({ holder: sender.name, absentee, auto: false }));
    this.setCallRef(today, null);
    const ref = await this.say(text, { buttons: this.dayKeyboard(today), replyTo: ctx.replyTo });
    this.setActionsRef(today, ref);
    return OK;
  }

  private async actFeito(sender: Participant, ctx: Ctx): Promise<Outcome> {
    const today = this.local().date;
    const day = this.repo.getDay(today);
    if (!day) return fail('Hoje não tem recolhimento.');
    if (day.status === 'fechado') return fail('O dia de hoje já foi encerrado. Valeu!');
    if (day.holderId !== sender.id) return fail(`Hoje o lixo está com ${this.name(day.holderId ?? day.callAbsenteeId)}.`);
    const res = this.finalizeDay(today, `feito ${sender.name}`);
    this.repo.updateDay(today, { doneAt: this.iso() });
    const delta = res ? res.delta : null;
    await ctx.ack(`Registrado${delta !== null ? ` (${msg.fmtPts(delta)})` : ''}. Valeu!`);
    const after = this.repo.getDay(today);
    await this.safeEdit(this.actionsRef(after), msg.doneNote({ date: today, holder: sender.name, delta }));
    await this.safeClear(this.callRef(after));
    this.setActionsRef(today, null);
    this.setCallRef(today, null);
    if (!ctx.viaButton) {
      await this.say(`Valeu, ${escapeHtml(sender.name)}! Registrado${delta !== null ? ` (${msg.fmtPts(delta)})` : ''}.`, {
        replyTo: ctx.replyTo,
      });
    }
    return OK;
  }

  // ================= vínculo pessoa <-> Telegram =================

  /** Vincula atomicamente; erro em texto puro ou null. */
  linkParticipant(participantId: number, sender: Sender): string | null {
    return this.repo.transaction(() => {
      const target = this.repo.getParticipant(participantId);
      if (!target || target.status === 'desligado') return 'Participante não encontrado.';
      const current = this.repo.findParticipantByTelegramId(sender.userId);
      if (current) {
        return current.id === target.id
          ? `Você já está vinculado como ${target.name}.`
          : `Você já está vinculado como ${current.name}. Peça ao admin para desfazer.`;
      }
      if (target.telegramUserId) return `${target.name} já está vinculado a outra pessoa. Peça ao admin para desfazer.`;
      this.repo.setParticipantTelegram(target.id, sender.userId, sender.username, sender.displayName);
      this.repo.logEvent(this.iso(), 'vinculo', {
        participant: target.name,
        telegramUserId: sender.userId,
        username: sender.username,
      });
      return null;
    });
  }

  private souPrompt(): { html: string; buttons: Keyboard } {
    const free = sortQueue(this.participants()).filter((p) => p.status === 'ativo' && !p.telegramUserId);
    const rows: Keyboard = [];
    for (let i = 0; i < free.length; i += 2) {
      rows.push(free.slice(i, i + 2).map((p) => ({ text: p.name, data: encodeButton({ type: 'sou', participantId: p.id }) })));
    }
    const html = free.length
      ? 'Quem é você? Toque no seu nome (vale uma vez; para corrigir, fale com o admin).'
      : 'Todos os participantes ativos já estão vinculados.';
    return { html, buttons: rows };
  }

  private async cmdSou(name: string, m: IncomingMessage, sender: Participant | null): Promise<void> {
    if (!name) {
      if (sender) return void (await this.say(`Você já está vinculado como ${escapeHtml(sender.name)}.`, { replyTo: m.messageId }));
      const prompt = this.souPrompt();
      await this.say(prompt.html, { buttons: prompt.buttons, replyTo: m.messageId });
      return;
    }
    const all = this.participants().filter((p) => p.status !== 'desligado');
    const target = all.find((p) => sameName(p.name, name));
    if (!target) {
      return void (await this.say(
        `Não encontrei "${escapeHtml(name)}". Nomes: ${escapeHtml(all.map((p) => p.name).join(', '))}.`,
        { replyTo: m.messageId },
      ));
    }
    const err = this.linkParticipant(target.id, m.sender);
    if (err) return void (await this.say(escapeHtml(err), { replyTo: m.messageId }));
    await this.say(
      `Ok! ${this.messenger.mention(m.sender.userId, m.sender.displayName)} agora é ${escapeHtml(target.name)}. ` +
        'Para receber o lembrete da véspera, mande /start no meu privado.',
      { replyTo: m.messageId },
    );
  }

  private async btnSou(participantId: number, a: IncomingAction): Promise<void> {
    const err = this.linkParticipant(participantId, a.sender);
    if (err) return a.answer(err);
    const p = this.repo.getParticipant(participantId)!;
    await a.answer(`Pronto, você é ${p.name}. Mande /start no meu privado para receber lembretes.`, true);
    const prompt = this.souPrompt();
    const html = `${prompt.html}\nVinculado agora: ${this.who(p)}.`;
    await this.safeEdit({ chatId: a.chatId, messageId: a.messageId }, html, prompt.buttons.length ? prompt.buttons : undefined);
  }

  /** Mantém username/nome de exibição atualizados. */
  private touch(p: Participant | null, s: Sender): void {
    if (!p) return;
    if (p.telegramUsername !== s.username || p.telegramName !== s.displayName) {
      this.repo.setParticipantTelegram(p.id, s.userId, s.username, s.displayName);
    }
  }

  privateStatus(userId: string | null): PrivateChatStatus {
    if (!userId) return 'desconhecido';
    const v = this.repo.getState(`dm:${userId}`);
    return v === 'ok' || v === 'bloqueado' ? v : 'desconhecido';
  }

  /** Chamado pelo canal quando o usuário inicia/bloqueia o privado. */
  setPrivateStatus(userId: string, status: 'ok' | 'bloqueado'): void {
    if (this.repo.getState(`dm:${userId}`) !== status) this.repo.setState(`dm:${userId}`, status);
  }

  // ================= vínculo do grupo =================

  /** Gera (e substitui) o código de uso único para `/vincular_grupo`. */
  generateGroupLinkCode(): GroupLinkCode {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.now().getTime() + LINK_CODE_TTL_MS;
    this.linkCode = { code, expiresAt, attempts: 0 };
    this.repo.logEvent(this.iso(), 'admin_codigo_grupo', { expiresAt: new Date(expiresAt).toISOString() });
    return { code, expiresAt: new Date(expiresAt) };
  }

  groupLinkCode(): GroupLinkCode | null {
    const c = this.linkCode;
    if (!c || c.expiresAt <= this.now().getTime()) return null;
    return { code: c.code, expiresAt: new Date(c.expiresAt) };
  }

  unlinkGroup(): void {
    const s = this.settings();
    this.repo.saveSettings({ groupId: null, groupName: null });
    this.repo.logEvent(this.iso(), 'admin_grupo_desvinculado', { groupId: s.groupId, groupName: s.groupName });
  }

  /** Grupo virou supergrupo: o Telegram troca o id. */
  migrateGroup(oldId: string, newId: string): void {
    if (this.settings().groupId !== oldId) return;
    this.repo.saveSettings({ groupId: newId });
    this.repo.logEvent(this.iso(), 'grupo_migrado', { oldId, newId });
  }

  private async cmdLinkGroup(code: string, m: IncomingMessage): Promise<void> {
    const reply = async (html: string) => {
      if (!this.messenger.isReady()) return;
      try {
        await this.messenger.send(m.chatId, { html, replyTo: m.messageId });
      } catch (err) {
        this.log.warn({ err }, 'falha ao responder vínculo de grupo');
      }
    };
    const s = this.settings();
    if (s.groupId === m.chatId) {
      if (this.cooledDown(`vinc:${m.chatId}`, 10_000)) await reply('Este grupo já está vinculado.');
      return;
    }
    const c = this.linkCode;
    const valid = c && c.expiresAt > this.now().getTime() && /^\d{6}$/.test(code) && code === c.code;
    if (!valid) {
      if (c && code) {
        c.attempts++;
        if (c.attempts >= LINK_CODE_MAX_ATTEMPTS) this.linkCode = null;
      }
      this.repo.logEvent(this.iso(), 'vinculo_grupo_recusado', { chatId: m.chatId, title: m.chatTitle, by: m.sender.userId });
      if (this.cooledDown(`vinc:${m.chatId}`, 10_000)) {
        await reply(code ? 'Código inválido ou expirado. Gere outro no painel.' : 'Use: /vincular_grupo &lt;código exibido no painel&gt;');
      }
      return;
    }
    this.linkCode = null;
    this.repo.saveSettings({ groupId: m.chatId, groupName: m.chatTitle });
    this.repo.logEvent(this.iso(), 'grupo_vinculado', { chatId: m.chatId, title: m.chatTitle, by: m.sender.userId });
    await reply(
      `Grupo vinculado! A partir de agora falo só aqui.\nCada pessoa: mande /sou e toque no seu nome. ` +
        'Para lembretes da véspera, mande /start no meu privado. /ajuda mostra os comandos.',
    );
  }

  // ================= entrada: mensagens =================

  async handleIncoming(m: IncomingMessage): Promise<void> {
    try {
      const cmd = parseCommand(m.text, this.messenger.botUsername());
      if (!cmd) return;
      if (m.chatKind === 'private') return await this.handlePrivate(cmd, m);
      if (m.chatKind !== 'group' && m.chatKind !== 'supergroup') return;
      if (cmd.type === 'vincular_grupo') return await this.cmdLinkGroup(cmd.code, m);
      const s = this.settings();
      if (!s.groupId || m.chatId !== s.groupId) return;
      const sender = this.repo.findParticipantByTelegramId(m.sender.userId);
      this.touch(sender, m.sender);
      await this.dispatch(cmd, m, sender);
    } catch (err) {
      this.log.error({ err }, 'erro ao processar mensagem');
    }
  }

  private async handlePrivate(cmd: Command, m: IncomingMessage): Promise<void> {
    if (!this.cooledDown(`dm:${m.sender.userId}`, 30_000)) return;
    this.setPrivateStatus(m.sender.userId, 'ok');
    const p = this.repo.findParticipantByTelegramId(m.sender.userId);
    this.touch(p, m.sender);
    let html: string;
    if (cmd.type === 'start' || cmd.type === 'ajuda') {
      html = p
        ? `Pronto, ${escapeHtml(p.name)}! Vou te avisar aqui na véspera do seu dia.`
        : 'Oi! Lembretes habilitados. Falta se vincular: no grupo do lixo, mande /sou e toque no seu nome.';
    } else {
      html = 'Os comandos funcionam no grupo do lixo. Aqui eu só mando o lembrete da véspera.';
    }
    try {
      await this.messenger.sendPrivate(m.sender.userId, html);
    } catch (err) {
      if (!(err instanceof PrivateChatUnavailableError)) this.log.warn({ err }, 'falha ao responder no privado');
    }
  }

  private textCtx(m: IncomingMessage): Ctx {
    return { viaButton: false, replyTo: m.messageId, source: null, ack: async () => {} };
  }

  private async dispatch(cmd: Command, m: IncomingMessage, sender: Participant | null): Promise<void> {
    const needLink = () => this.say('Primeiro vincule seu Telegram: mande /sou e toque no seu nome.', { replyTo: m.messageId });
    const run = async (fn: () => Promise<Outcome>) => {
      const r = await fn();
      if (!r.ok) await this.say(escapeHtml(r.error), { replyTo: m.messageId });
    };
    switch (cmd.type) {
      case 'start':
      case 'ajuda':
        if (this.cooledDown('ajuda')) await this.say(msg.helpText(this.messenger.botUsername()));
        return;
      case 'escala':
        if (this.cooledDown('escala')) await this.say(this.escalaText());
        return;
      case 'ranking':
        if (this.cooledDown('ranking')) await this.say(this.rankingText());
        return;
      case 'hoje':
        if (this.cooledDown('hoje')) await this.say(this.hojeText());
        return;
      case 'sou':
        await this.cmdSou(cmd.name, m, sender);
        return;
      case 'vincular_grupo':
        return;
      case 'naoposso': {
        if (cmd.natural) {
          const day = this.repo.getDay(this.local().date);
          if (!sender || !day || day.holderId !== sender.id || day.status !== 'aberto') return;
        }
        if (!sender) return void (await needLink());
        await run(() => this.actNaoPosso(sender, this.textCtx(m)));
        return;
      }
      case 'faltou':
        if (!sender) return void (await needLink());
        await run(() => this.actFaltou(sender, cmd.name, this.textCtx(m)));
        return;
      case 'eupego': {
        if (cmd.natural) {
          const day = this.repo.getDay(this.local().date);
          if (!sender || !day || day.status !== 'chamada') return;
        }
        if (!sender) return void (await needLink());
        await run(() => this.actEuPego(sender, this.textCtx(m)));
        return;
      }
      case 'feito':
        if (!sender) return void (await needLink());
        await run(() => this.actFeito(sender, this.textCtx(m)));
        return;
    }
  }

  // ================= entrada: botões =================

  async handleAction(a: IncomingAction): Promise<void> {
    try {
      const act = decodeButton(a.data);
      const s = this.settings();
      if (!act || !s.groupId || a.chatId !== s.groupId) return await a.answer('Botão inválido.');
      const sender = this.repo.findParticipantByTelegramId(a.sender.userId);
      this.touch(sender, a.sender);
      if (act.type === 'sou') return await this.btnSou(act.participantId, a);
      if (!sender) return await a.answer('Primeiro vincule seu Telegram: mande /sou no grupo e toque no seu nome.', true);
      if (act.date !== this.local().date) return await a.answer('Este botão é de outro dia.');
      const ctx: Ctx = {
        viaButton: true,
        replyTo: null,
        source: { chatId: a.chatId, messageId: a.messageId },
        ack: (text, alert) => a.answer(text, alert),
      };
      let r: Outcome;
      switch (act.type) {
        case 'naoposso':
          r = await this.actNaoPosso(sender, ctx);
          break;
        case 'faltou':
          r = await this.actFaltou(sender, null, ctx);
          break;
        case 'eupego':
          r = await this.actEuPego(sender, ctx);
          break;
        case 'feito':
          r = await this.actFeito(sender, ctx);
          break;
      }
      if (!r.ok) await a.answer(r.error);
    } catch (err) {
      this.log.error({ err }, 'erro ao processar botão');
      await a.answer('Erro ao processar. Tente de novo.').catch(() => undefined);
    }
  }

  // ================= textos =================

  escalaText(count = 6): string {
    const n = (id: number | null) => escapeHtml(this.name(id));
    const lines = this.upcoming(count).map((u) => {
      let suffix = '';
      if (u.record) {
        if (u.record.status === 'chamada') suffix = ` (procurando quem cubra ${n(u.record.callAbsenteeId)})`;
        else if (u.record.holderId !== u.record.originalId) suffix = ` (cobrindo ${n(u.record.callAbsenteeId)})`;
        else if (u.record.status === 'fechado') suffix = ' (feito)';
      }
      const who = u.record?.status === 'chamada' ? '?' : escapeHtml(u.participant?.name ?? '?');
      return `${formatShort(u.date)}: ${who}${suffix}`;
    });
    return lines.length ? `<b>Escala</b>\n${lines.join('\n')}` : 'Nenhum dia ativo configurado.';
  }

  hojeText(): string {
    const s = this.settings();
    const today = this.local().date;
    const n = (id: number | null) => escapeHtml(this.name(id));
    const day = this.todayIfActive();
    if (!day) {
      const next = this.upcoming(1, addDays(today, 1))[0];
      return `Hoje não tem recolhimento.${next?.participant ? ` Próximo: ${formatShort(next.date)} com ${escapeHtml(next.participant.name)}.` : ''}`;
    }
    if (day.status === 'chamada') {
      return `Hoje: procurando quem cubra ${n(day.callAbsenteeId)}. Toque em <b>Eu pego</b> ou use /eupego (vale ${msg.fmtPts(s.points.cover)}).`;
    }
    const cover = day.holderId !== day.originalId ? ` (cobrindo ${n(day.callAbsenteeId)})` : '';
    const done = day.status === 'fechado' ? ' Já foi feito.' : '';
    return `Hoje (${formatShort(today)}) o lixo é com ${n(day.holderId)}${cover}.${done}`;
  }

  rankingText(): string {
    const month = monthKey(this.local().date);
    return msg.rankingText({
      title: 'Ranking',
      month,
      scores: this.repo.scores(month),
      debts: this.repo.debts(),
      showTotal: true,
    });
  }

  // ================= admin =================

  addParticipant(name: string): Participant {
    const clean = name.trim();
    if (!clean || clean.length > 40) throw new Error('Nome inválido');
    const p = this.repo.addParticipant(clean);
    this.repo.logEvent(this.iso(), 'admin_participante_add', { name: clean });
    return p;
  }

  renameParticipant(id: number, name: string): void {
    const clean = name.trim();
    if (!clean || clean.length > 40) throw new Error('Nome inválido');
    this.repo.renameParticipant(id, clean);
    this.repo.logEvent(this.iso(), 'admin_participante_renomear', { id, name: clean });
  }

  setStatus(id: number, status: ParticipantStatus): void {
    this.repo.setParticipantStatus(id, status);
    this.repo.logEvent(this.iso(), 'admin_status', { id, name: this.name(id), status });
  }

  move(id: number, dir: -1 | 1): void {
    const q = sortQueue(this.participants());
    const i = q.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= q.length) return;
    [q[i], q[j]] = [q[j]!, q[i]!];
    this.repo.reorder(q.map((p) => p.id));
    this.repo.logEvent(this.iso(), 'admin_reordenar', { order: q.map((p) => p.name) });
  }

  /** Admin define/remove o user id do Telegram de alguém. */
  setTelegram(id: number, userId: string | null): void {
    this.repo.transaction(() => {
      if (userId) {
        if (!/^\d{1,16}$/.test(userId)) throw new Error('User id do Telegram deve ser numérico');
        const other = this.repo.findParticipantByTelegramId(userId);
        if (other && other.id !== id) throw new Error(`Este user id já está vinculado a ${other.name}`);
        const cur = this.repo.getParticipant(id);
        if (cur?.telegramUserId === userId) return;
      }
      this.repo.setParticipantTelegram(id, userId, null, null);
      this.repo.logEvent(this.iso(), 'admin_vinculo', { id, name: this.name(id), telegramUserId: userId });
    });
  }

  adjustPoints(participantId: number, delta: number, reason: string, actor: string): void {
    if (!Number.isInteger(delta) || delta === 0) throw new Error('Valor inválido');
    if (!reason.trim()) throw new Error('Informe o motivo');
    this.repo.addPoints({
      participantId,
      refDate: this.local().date,
      delta,
      kind: 'ajuste',
      reason: reason.trim().slice(0, 200),
      actor,
      createdAt: this.iso(),
    });
    this.repo.logEvent(this.iso(), 'admin_ajuste_pontos', { participant: this.name(participantId), delta, reason, actor });
  }

  updateSettings(partial: Partial<Settings>): void {
    this.repo.saveSettings(partial);
    this.repo.logEvent(this.iso(), 'admin_config', partial);
  }

  /**
   * Desfaz a escala de um dia ainda não fechado (ex.: feriado cadastrado tarde) e
   * marca a data como feriado.
   * Só permitido para o último dia gerado, para não bagunçar a fila.
   */
  cancelDay(date: ISODate): void {
    const refs = this.repo.transaction(() => {
      const day = this.repo.getDay(date);
      if (!day) throw new Error('Dia não existe');
      if (day.finalizedAt) throw new Error('Dia já fechado; use ajuste de pontos');
      if (this.repo.getState(STATE_LAST_GENERATED) !== date) throw new Error('Só é possível desfazer o último dia gerado');
      const prev = this.repo.db
        .prepare('SELECT date, original_id FROM days WHERE date < ? ORDER BY date DESC LIMIT 1')
        .get(date) as { date: string; original_id: number } | undefined;
      this.repo.db.prepare("DELETE FROM points WHERE ref_date = ? AND kind IN ('coberto','falta')").run(date);
      this.repo.db.prepare('DELETE FROM coverages WHERE date = ?').run(date);
      this.repo.db.prepare('DELETE FROM days WHERE date = ?').run(date);
      if (prev) {
        this.repo.setState(STATE_LAST_ASSIGNED, String(prev.original_id));
        this.repo.setState(STATE_LAST_GENERATED, prev.date);
      } else {
        this.repo.db.prepare('DELETE FROM state WHERE key IN (?, ?)').run(STATE_LAST_ASSIGNED, STATE_LAST_GENERATED);
      }
      // Marca a data como sem recolhimento, para não ser regerada.
      const s = this.settings();
      if (!s.holidays.includes(date)) this.repo.saveSettings({ holidays: [...s.holidays, date].sort() });
      this.repo.logEvent(this.iso(), 'admin_desfazer_dia', { date, original: this.name(day.originalId) });
      return [this.actionsRef(day), this.callRef(day)];
    });
    for (const r of refs) void this.safeClear(r);
  }
}
