/**
 * Fila por saldo de turnos (pura, sem I/O).
 *
 * Cada participante tem um saldo: +1 por dia que efetivamente ficou com ele
 * (próprio turno ou cobertura). O escalado do dia é o participante `ativo` de
 * menor saldo; empate: quem recolheu há mais tempo (quem nunca recolheu
 * primeiro), depois a posição na lista.
 *
 * O nivelamento subtrai de todos os ativos a moda dos saldos dos ativos. Como
 * subtrai o mesmo valor de todos, não muda a ordem entre eles; serve para que
 * quem entra (0) ou volta de férias (offset guardado) fique na posição certa.
 */
import type { ISODate } from './dates.js';
import type { Participant } from './types.js';

/** Ordem da lista (posição). Usada para exibição e como último desempate. */
export function sortQueue(participants: Participant[]): Participant[] {
  return [...participants].sort((a, b) => a.position - b.position || a.id - b.id);
}

/** Valor mais comum; empate entre modas -> o menor. Lista vazia -> 0. */
export function modeOf(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v < best)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** Último dia efetivo por participante (id -> data). */
export type LastDates = ReadonlyMap<number, ISODate>;

interface Candidate {
  p: Participant;
  balance: number;
  last: ISODate | null;
}

function compare(a: Candidate, b: Candidate): number {
  if (a.balance !== b.balance) return a.balance - b.balance;
  if (a.last !== b.last) {
    if (a.last === null) return -1;
    if (b.last === null) return 1;
    return a.last < b.last ? -1 : 1;
  }
  return a.p.position - b.p.position || a.p.id - b.p.id;
}

function candidates(participants: Participant[], last: LastDates, exclude: ReadonlySet<number>): Candidate[] {
  return participants
    .filter((p) => p.status === 'ativo' && !exclude.has(p.id))
    .map((p) => ({ p, balance: p.balance, last: last.get(p.id) ?? null }));
}

/** Ativos na ordem em que seriam escalados agora (sem simular). */
export function queueOrder(participants: Participant[], last: LastDates): Participant[] {
  return candidates(participants, last, new Set())
    .sort(compare)
    .map((c) => c.p);
}

/** Próximo escalado: ativo de menor saldo (com desempates). `exclude` remove candidatos. */
export function chooseNext(
  participants: Participant[],
  last: LastDates,
  exclude: ReadonlySet<number> = new Set(),
): Participant | null {
  const list = candidates(participants, last, exclude).sort(compare);
  return list[0]?.p ?? null;
}

export interface Prediction {
  date: ISODate;
  participant: Participant | null;
}

/** Prevê a escala de `dates` (já filtradas como dias ativos), simulando +1 no escolhido a cada dia. */
export function predict(participants: Participant[], last: LastDates, dates: ISODate[]): Prediction[] {
  const sim = participants.map((p) => ({ ...p }));
  const lastSim = new Map(last);
  const out: Prediction[] = [];
  for (const date of dates) {
    const p = chooseNext(sim, lastSim);
    out.push({ date, participant: p ? participants.find((x) => x.id === p.id)! : null });
    if (p) {
      p.balance += 1;
      lastSim.set(p.id, date);
    }
  }
  return out;
}
