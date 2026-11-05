/** Textos enviados pelo bot (puros), em HTML do Telegram. Conteúdo dinâmico sempre escapado. */
import { formatShort, monthLabel, type ISODate } from './dates.js';
import type { DebtRow, ScoreRow } from '../db/repository.js';

/** Escape para parse_mode HTML do Telegram (também serve para atributos). */
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const e = escapeHtml;
const plural = (n: number) => (Math.abs(n) === 1 ? 'pt' : 'pts');
export const fmtPts = (n: number) => `${n > 0 ? '+' : ''}${n} ${plural(n)}`;

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

export function callOpened(opts: { absentee: string; coverPoints: number; deadline: string }): string {
  return (
    `Quem cobre ${e(opts.absentee)} hoje? Vale <b>${fmtPts(opts.coverPoints)}</b>. Toque em <b>Eu pego</b>.\n` +
    `Se ninguém pegar até ${e(opts.deadline)}, escalo o próximo da fila.`
  );
}

/** `holder` já vem em HTML (menção). */
export function claimed(opts: { holder: string; absentee: string; coverPoints: number }): string {
  return `Valeu, ${opts.holder}! Hoje o lixo é com você (cobrindo ${e(opts.absentee)}). ${fmtPts(opts.coverPoints)} ao fim do dia.`;
}

export function coveredNote(opts: { holder: string; absentee: string; auto: boolean }): string {
  return opts.auto
    ? `Ninguém se voluntariou para cobrir ${e(opts.absentee)}; ficou com ${e(opts.holder)}.`
    : `${e(opts.holder)} pegou o dia de ${e(opts.absentee)}.`;
}

/** `holder` já vem em HTML (menção). */
export function autoEscalated(opts: { holder: string; absentee: string; coverPoints: number }): string {
  return `Ninguém se voluntariou. ${opts.holder}, hoje o lixo fica com você (cobrindo ${e(opts.absentee)}). Vale ${fmtPts(opts.coverPoints)}.`;
}

export function doneNote(opts: { date: ISODate; holder: string; delta: number | null }): string {
  return `Hoje (${formatShort(opts.date)}): feito por ${e(opts.holder)}${opts.delta !== null ? ` (${fmtPts(opts.delta)})` : ''}. Valeu!`;
}

export function dayClosedNote(opts: { date: ISODate }): string {
  return `Dia ${formatShort(opts.date)} encerrado.`;
}

export function rankingText(opts: {
  title: string;
  month: string;
  scores: ScoreRow[];
  debts: DebtRow[];
  showTotal: boolean;
}): string {
  const rows = opts.scores.filter((s) => s.status !== 'desligado' || s.total !== 0 || s.month !== 0);
  const lines = rows.map(
    (s, i) => `${i + 1}. ${e(s.name)}: ${s.month} ${plural(s.month)}` + (opts.showTotal ? ` (total ${s.total})` : ''),
  );
  let text = `<b>${e(opts.title)} - ${monthLabel(opts.month)}</b>\n${lines.join('\n')}`;
  if (opts.debts.length > 0) {
    const d = opts.debts
      .slice(0, 8)
      .map((x) => `${e(x.covererName)} cobriu ${e(x.coveredName)}${x.count > 1 ? ` (${x.count}x)` : ''}`);
    text += `\n\n<b>Coberturas</b>\n${d.join('\n')}`;
  }
  return text;
}

export function helpText(botUsername: string | null): string {
  const privateLink = botUsername
    ? `<a href="https://t.me/${e(botUsername)}">@${e(botUsername)}</a>`
    : 'o bot';
  return [
    '<b>Comandos do lixo</b>',
    'No aviso diário use os botões <b>Não posso</b> (só o escalado), <b>Faltou</b> (colega não veio/esqueceu) e <b>Feito</b>. Na chamada de cobertura, <b>Eu pego</b>.',
    '',
    '/hoje - quem está com o lixo hoje',
    '/escala - próximos dias',
    '/ranking - placar do mês e total',
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
