/**
 * Lógica de datas pura. Datas de calendário são strings ISO "YYYY-MM-DD"
 * (sem fuso); a conversão de um instante para data/hora local é feita
 * explicitamente com o fuso informado.
 */

export type ISODate = string; // YYYY-MM-DD

/** 0 = domingo ... 6 = sábado */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;
export const WEEKDAY_LONG = [
  'domingo',
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
] as const;
export const MONTH_NAMES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

function parse(date: ISODate): Date {
  if (!isISODate(date)) throw new Error(`Data inválida: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: ISODate, n: number): ISODate {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: ISODate): Weekday {
  return parse(date).getUTCDay() as Weekday;
}

export function monthKey(date: ISODate): string {
  return date.slice(0, 7);
}

export function previousMonthKey(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]}/${y}`;
}

/** "ter, 03/11" */
export function formatShort(date: ISODate): string {
  return `${WEEKDAY_SHORT[weekdayOf(date)]}, ${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

export interface LocalNow {
  date: ISODate;
  /** minutos desde 00:00 no fuso local */
  minutes: number;
}

/** Converte um instante para data e minuto-do-dia no fuso informado. */
export function localNow(instant: Date, tz: string): LocalNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** "HH:MM" -> minutos. Lança erro se inválido. */
export function parseHHMM(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) throw new Error(`Horário inválido: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface CalendarRules {
  activeWeekdays: Weekday[];
  holidays: ISODate[];
}

export function isActiveDay(date: ISODate, rules: CalendarRules): boolean {
  return rules.activeWeekdays.includes(weekdayOf(date)) && !rules.holidays.includes(date);
}

/** Próximos `count` dias ativos a partir de `from` (inclusive se `inclusive`). */
export function nextActiveDays(
  from: ISODate,
  count: number,
  rules: CalendarRules,
  inclusive = true,
): ISODate[] {
  const out: ISODate[] = [];
  if (rules.activeWeekdays.length === 0) return out;
  let d = inclusive ? from : addDays(from, 1);
  // limite de segurança: 2 anos
  for (let i = 0; i < 730 && out.length < count; i++) {
    if (isActiveDay(d, rules)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
