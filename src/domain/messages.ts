/** Textos enviados pelo bot (puros), em HTML do Telegram. Conteúdo dinâmico sempre escapado. */
import { formatShort, monthLabel, type ISODate } from './dates.js';
import type { DayStatsRow } from '../db/repository.js';

/** Escape para parse_mode HTML do Telegram (também serve para atributos). */
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const e = escapeHtml;

/** A regra da fila em uma linha (ajuda, escala, saldo). */
export const QUEUE_RULE = 'A fila segue quem recolheu menos; cobrir um colega adianta sua folga 1 para 1.';

/** `holder` já vem em HTML (menção). */
export function dailyAnnouncement(opts: {
  date: ISODate;
  holder: string;
  next: { date: ISODate; name: string; isTomorrow: boolean } | null;
}): string {
  const nextPart = opts.next
    ? opts.next.isTomorrow
      ? ` Amanhã: ${e(opts.next.name)}.`
      : ` Próximo (${formatShort(opts.next.date)}): ${e(opts.next.name)}.`
    : '';
  return `Hoje (${formatShort(opts.date)}) o lixo é com ${opts.holder}.${nextPart}\nSe não puder, toque em <b>Não posso</b>.`;
}

export function callClosedNote(opts: { date: ISODate; absentee: string; reason: 'naoposso' | 'faltou'; actor: string }): string {
  return opts.reason === 'naoposso'
    ? `Hoje (${formatShort(opts.date)}): ${e(opts.absentee)} avisou que não pode.`
    : `Hoje (${formatShort(opts.date)}): falta de ${e(opts.absentee)} reportada por ${e(opts.actor)}.`;
}

export function callOpened(opts: { absentee: string; deadline: string }): string {
  return (
    `Quem cobre ${e(opts.absentee)} hoje? Cobrir adianta sua folga (1 para 1). Toque em <b>Eu pego</b>.\n` +
    `Se ninguém pegar até ${e(opts.deadline)}, escalo quem recolheu menos.`
  );
}

/** `holder` já vem em HTML (menção). */
export function claimed(opts: { holder: string; absentee: string }): string {
  return `Valeu, ${opts.holder}! Hoje o lixo é com você (cobrindo ${e(opts.absentee)}). Sua folga adianta 1 dia.`;
}

export function coveredNote(opts: { holder: string; absentee: string; auto: boolean }): string {
  return opts.auto
    ? `Ninguém se voluntariou para cobrir ${e(opts.absentee)}; ficou com ${e(opts.holder)}.`
    : `${e(opts.holder)} pegou o dia de ${e(opts.absentee)}.`;
}

/** `holder` já vem em HTML (menção). */
export function autoEscalated(opts: { holder: string; absentee: string }): string {
  return `Ninguém se voluntariou. ${opts.holder}, hoje o lixo fica com você (cobrindo ${e(opts.absentee)}). Sua folga adianta 1 dia.`;
}

export function doneNote(opts: { date: ISODate; holder: string }): string {
  return `Hoje (${formatShort(opts.date)}): feito por ${e(opts.holder)}. Valeu!`;
}

/** Saldo atual dos ativos (na ordem da fila) + dias recolhidos/coberturas por pessoa. */
export function saldoText(opts: { month: string; queue: DayStatsRow[]; stats: DayStatsRow[] }): string {
  const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));
  const q = opts.queue.map((s, i) => `${i + 1}. ${e(s.name)}: ${fmt(s.balance)}`);
  const st = opts.stats
    .filter((s) => s.status !== 'desligado' || s.days > 0)
    .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name))
    .map((s) => `${e(s.name)}: ${s.monthDays} no mês, ${s.days} no total (${s.covers} ${s.covers === 1 ? 'cobertura' : 'coberturas'})`);
  return [
    '<b>Saldo de turnos</b> (o primeiro é o próximo)',
    ...q,
    '',
    `<b>Dias recolhidos</b> (${monthLabel(opts.month)} / total)`,
    ...st,
    '',
    QUEUE_RULE,
  ].join('\n');
}

/** Resumo curto do mês anterior (só quem recolheu algum dia). */
export function monthSummaryText(month: string, stats: DayStatsRow[]): string | null {
  const rows = stats
    .filter((s) => s.monthDays > 0)
    .sort((a, b) => b.monthDays - a.monthDays || a.name.localeCompare(b.name))
    .map((s) => `${e(s.name)}: ${s.monthDays} ${s.monthDays === 1 ? 'dia' : 'dias'}${s.monthCovers ? ` (${s.monthCovers} ${s.monthCovers === 1 ? 'cobertura' : 'coberturas'})` : ''}`);
  return rows.length ? `<b>Resumo de ${monthLabel(month)}</b>\n${rows.join('\n')}` : null;
}

export function helpText(botUsername: string | null): string {
  const privateLink = botUsername
    ? `<a href="https://t.me/${e(botUsername)}">@${e(botUsername)}</a>`
    : 'o bot';
  return [
    '<b>Comandos do lixo</b>',
    QUEUE_RULE,
    'No aviso diário use os botões <b>Não posso</b> (só o escalado), <b>Faltou</b> (colega não veio/esqueceu) e <b>Feito</b>. Na chamada de cobertura, <b>Eu pego</b>.',
    '',
    '/hoje - quem está com o lixo hoje',
    '/escala - próximos dias',
    '/saldo - saldo de turnos (fila) e dias recolhidos',
    '/sou - vincula seu Telegram ao seu nome (uma vez)',
    '/naoposso - o escalado avisa que não pode (abre chamada)',
    '/faltou - avisa que o escalado não pôde/esqueceu (abre chamada)',
    '/eupego - assume o dia de quem não pode',
    '/feito - confirma que recolheu',
    '',
    `Lembrete na véspera: abra o privado com ${privateLink} e mande /start (só precisa uma vez).`,
  ].join('\n');
}

export function reminderText(date: ISODate): string {
  return `Lembrete: amanhã (${formatShort(date)}) o lixo é com você. Se não puder, toque em <b>Não posso</b> no aviso do grupo ou use /naoposso.`;
}
