/** Painel admin: HTML server-rendered simples, protegido por Basic Auth + token CSRF. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ChannelStatus } from '../channel/types.js';
import {
  WEEKDAY_LONG,
  formatShort,
  isISODate,
  monthKey,
  monthLabel,
  parseHHMM,
  type Weekday,
} from '../domain/dates.js';
import { QUEUE_RULE } from '../domain/messages.js';
import type { DutyService } from '../domain/service.js';
import { PARTICIPANT_STATUSES, type ParticipantStatus, type Settings } from '../domain/types.js';

export interface ChannelControl {
  getStatus(): ChannelStatus;
}

export interface AdminOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  service: DutyService;
  channel: ChannelControl;
  /** fuso para exibir horários */
  tz: string;
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtBal = (n: number) => (n > 0 ? `+${n}` : String(n));

const sha = (s: string) => createHash('sha256').update(s).digest();

const STATUS_LABEL: Record<string, string> = {
  desabilitado: 'Desabilitado (TELEGRAM_ENABLED=false)',
  conectando: 'Conectando...',
  conectado: 'Conectado',
  erro: 'Erro (tentando de novo; veja o último erro)',
};

const DM_LABEL: Record<string, string> = {
  ok: '<span class="tag ok">privado ok</span>',
  bloqueado: '<span class="tag bad" title="Nunca mandou /start ao bot ou bloqueou: não recebe lembrete">sem privado</span>',
  desconhecido: '<span class="tag warn" title="Ainda não mandou /start no privado do bot">privado?</span>',
};

export function startAdmin(opts: AdminOptions): Server {
  const { service, channel, tz } = opts;
  const csrf = randomBytes(24).toString('hex');
  const failures = new Map<string, { n: number; until: number }>();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, telegram: channel.getStatus().state });
  });

  // ---- autenticação ----
  app.use((req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const f = failures.get(ip);
    if (f && f.n >= 10 && f.until > Date.now()) return void res.status(429).send('Muitas tentativas. Aguarde.');
    const header = req.headers.authorization ?? '';
    const [scheme, b64] = header.split(' ');
    if (scheme === 'Basic' && b64) {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      const ok = timingSafeEqual(sha(u), sha(opts.user)) && timingSafeEqual(sha(p), sha(opts.password));
      if (idx > 0 && ok) {
        failures.delete(ip);
        return next();
      }
      const cur = failures.get(ip) ?? { n: 0, until: 0 };
      failures.set(ip, { n: cur.n + 1, until: Date.now() + 15 * 60_000 });
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="lixo-bot", charset="UTF-8"');
    res.status(401).send('Autenticação necessária');
  });

  // ---- CSRF em todo POST ----
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      try {
        if (new URL(origin).host !== req.headers.host) return void res.status(403).send('Origem inválida');
      } catch {
        return void res.status(403).send('Origem inválida');
      }
    }
    const body = req.body as Record<string, string> | undefined;
    const token = body?._csrf ?? '';
    if (token.length !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) {
      return void res.status(403).send('Token CSRF inválido; recarregue a página.');
    }
    next();
  });

  const hidden = `<input type="hidden" name="_csrf" value="${csrf}">`;
  const form = (action: string, inner: string, cls = 'inline') =>
    `<form method="post" action="${esc(action)}" class="${cls}">${hidden}${inner}</form>`;

  const layout = (title: string, body: string, flash?: string) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Lixo Bot</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f5f5f4;color:#1c1917}
header{background:#14532d;color:#fff;padding:10px 16px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
header a{color:#fff;text-decoration:none;font-weight:500}header strong{margin-right:12px}
main{max-width:1000px;margin:0 auto;padding:16px}
section{background:#fff;border:1px solid #e7e5e4;border-radius:8px;padding:12px 16px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}
.inline{display:inline}.muted{color:#78716c;font-size:13px}.flash{background:#dcfce7;border:1px solid #86efac;padding:8px 12px;border-radius:6px;margin-bottom:12px}
.err{background:#fee2e2;border-color:#fca5a5}
button{cursor:pointer;padding:3px 8px}input,select,textarea{font:inherit;padding:3px 6px}
.tag{display:inline-block;padding:1px 6px;border-radius:4px;background:#e7e5e4;font-size:12px}
.ok{background:#bbf7d0}.warn{background:#fde68a}.bad{background:#fecaca}
label{margin-right:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 16px}
</style></head><body>
<header><strong>Lixo Bot</strong><a href="/">Início</a><a href="/participantes">Participantes</a><a href="/config">Configuração</a><a href="/grupo">Grupo</a><a href="/saldo">Saldo</a><a href="/historico">Histórico</a></header>
<main>${flash ? `<div class="flash${flash.startsWith('Erro') ? ' err' : ''}">${esc(flash)}</div>` : ''}${body}</main></body></html>`;

  const back = (res: Response, to: string, message: string) =>
    res.redirect(303, `${to}?msg=${encodeURIComponent(message)}`);

  const action =
    (to: string, fn: (req: Request) => string | Promise<string>) =>
    async (req: Request, res: Response, _next: NextFunction) => {
      try {
        back(res, to, await fn(req));
      } catch (err) {
        back(res, to, `Erro: ${(err as Error).message}`);
      }
    };

  const flashOf = (req: Request) => (typeof req.query.msg === 'string' ? req.query.msg.slice(0, 300) : undefined);
  const body = (req: Request) => (req.body ?? {}) as Record<string, string | string[] | undefined>;
  const str = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
  const pid = (req: Request) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || !service.repo.getParticipant(n)) throw new Error('Participante inválido');
    return n;
  };

  // ---------- início ----------
  app.get('/', (req, res) => {
    const st = channel.getStatus();
    const s = service.settings();
    const cls = st.state === 'conectado' ? 'ok' : st.state === 'erro' ? 'bad' : 'warn';
    const up = service.upcoming(8);
    const rows = up
      .map((u) => {
        const r = u.record;
        let extra = r ? `<span class="tag">${esc(r.status)}</span>` : '<span class="tag">previsto</span>';
        if (r && r.holderId !== null && r.holderId !== r.originalId) {
          extra += ` cobrindo ${esc(service.repo.getParticipant(r.callAbsenteeId ?? r.originalId)?.name)}`;
        }
        if (r?.status === 'chamada') extra += ` chamada aberta até ${esc(r.callDeadline ?? '-')}`;
        const undo =
          r && !r.finalizedAt
            ? form(`/dia/${r.date}/desfazer`, `<button title="Desfaz a escala e marca como feriado">Desfazer + feriado</button>`)
            : '';
        return `<tr><td>${esc(formatShort(u.date))}</td><td>${esc(r?.status === 'chamada' ? '?' : u.participant?.name ?? '-')}</td><td>${extra}</td><td>${undo}</td></tr>`;
      })
      .join('');
    const queue = service
      .queue()
      .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${fmtBal(p.balance)}</td></tr>`)
      .join('');
    res.send(
      layout(
        'Início',
        `<section><h2>Telegram</h2><p><span class="tag ${cls}">${esc(STATUS_LABEL[st.state] ?? st.state)}</span>
${st.me ? ` bot: <code>${esc(st.me)}</code>` : ''} <span class="muted">(${esc(st.updatedAt)})</span></p>
${st.lastError ? `<p class="muted">Último erro: ${esc(st.lastError)}</p>` : ''}
<p>Grupo vinculado: ${s.groupId ? `<strong>${esc(s.groupName ?? s.groupId)}</strong>` : '<span class="tag bad">nenhum</span> <a href="/grupo">vincular</a>'}</p></section>
<section><h2>Escala</h2><table><tr><th>Dia</th><th>Responsável</th><th>Situação</th><th></th></tr>${rows || '<tr><td colspan=4>Nenhum dia ativo.</td></tr>'}</table></section>
<section><h2>Fila agora</h2><p class="muted">${esc(QUEUE_RULE)} Detalhes em <a href="/saldo">Saldo</a>.</p>
<table><tr><th>#</th><th>Nome</th><th>Saldo</th></tr>${queue || '<tr><td colspan=3>Nenhum ativo.</td></tr>'}</table></section>`,
        flashOf(req),
      ),
    );
  });

  // ---------- participantes ----------
  app.get('/participantes', (req, res) => {
    const list = service.repo.listParticipants();
    const rows = list
      .map((p, i) => {
        const statusSel = `<select name="status">${PARTICIPANT_STATUSES.map((s) => `<option${s === p.status ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
        return `<tr>
<td>${i + 1}</td>
<td>${form(`/participantes/${p.id}/renomear`, `<input name="name" value="${esc(p.name)}" size="12" maxlength="40"><button>ok</button>`)}</td>
<td>${form(`/participantes/${p.id}/status`, `${statusSel}<button>ok</button>`)}</td>
<td>${form(`/participantes/${p.id}/mover`, `<input type="hidden" name="dir" value="-1"><button ${i === 0 ? 'disabled' : ''}>&uarr;</button>`)}
${form(`/participantes/${p.id}/mover`, `<input type="hidden" name="dir" value="1"><button ${i === list.length - 1 ? 'disabled' : ''}>&darr;</button>`)}</td>
<td>${p.telegramUserId ? `${esc(p.telegramName ?? '')}${p.telegramUsername ? ` <span class="muted">@${esc(p.telegramUsername)}</span>` : ''} ${DM_LABEL[service.privateStatus(p.telegramUserId)]}<br>` : '<span class="tag">não vinculado</span><br>'}
${form(`/participantes/${p.id}/vinculo`, `<input name="telegramUserId" value="${esc(p.telegramUserId)}" placeholder="user id numérico" size="14" inputmode="numeric" pattern="[0-9]{1,16}"><button>salvar</button>`)}
${p.telegramUserId ? form(`/participantes/${p.id}/vinculo`, `<input type="hidden" name="telegramUserId" value=""><button>desvincular</button>`) : ''}</td>
</tr>`;
      })
      .join('');
    res.send(
      layout(
        'Participantes',
        `<section><h2>Participantes</h2><p class="muted">A escala segue o saldo de turnos (veja <a href="/saldo">Saldo</a>); a ordem da lista só desempata.
Férias: sai da fila guardando a distância para os demais e volta com ela. Desligado: sai da escala mantendo o histórico; se voltar, entra com saldo 0.
O vínculo com o Telegram normalmente é feito pela própria pessoa com <code>/sou</code> no grupo. "sem privado" = a pessoa não mandou /start no privado do bot (ou o bloqueou) e não recebe o lembrete da véspera.</p>
<table><tr><th>#</th><th>Nome</th><th>Status</th><th>Ordem</th><th>Telegram</th></tr>${rows}</table></section>
<section><h2>Adicionar</h2>${form('/participantes', `<input name="name" required maxlength="40" placeholder="Nome"> <button>Adicionar (entra com saldo 0)</button>`)}</section>`,
        flashOf(req),
      ),
    );
  });

  app.post('/participantes', action('/participantes', (req) => `Adicionado: ${service.addParticipant(str(body(req).name)).name}`));
  app.post(
    '/participantes/:id/renomear',
    action('/participantes', (req) => {
      service.renameParticipant(pid(req), str(body(req).name));
      return 'Nome atualizado';
    }),
  );
  app.post(
    '/participantes/:id/status',
    action('/participantes', (req) => {
      const st = str(body(req).status) as ParticipantStatus;
      if (!PARTICIPANT_STATUSES.includes(st)) throw new Error('Status inválido');
      service.setStatus(pid(req), st);
      return 'Status atualizado';
    }),
  );
  app.post(
    '/participantes/:id/mover',
    action('/participantes', (req) => {
      service.move(pid(req), str(body(req).dir) === '-1' ? -1 : 1);
      return 'Ordem atualizada';
    }),
  );
  app.post(
    '/participantes/:id/vinculo',
    action('/participantes', (req) => {
      const id = str(body(req).telegramUserId).trim();
      if (id && !/^\d{1,16}$/.test(id)) throw new Error('User id do Telegram deve ser numérico');
      service.setTelegram(pid(req), id || null);
      return id ? 'Vínculo salvo' : 'Vínculo removido';
    }),
  );

  // ---------- configuração ----------
  app.get('/config', (req, res) => {
    const s = service.settings();
    const days = WEEKDAY_LONG.map(
      (n, i) => `<label><input type="checkbox" name="days" value="${i}"${s.activeWeekdays.includes(i as Weekday) ? ' checked' : ''}> ${n}</label>`,
    ).join('');
    const t = (name: keyof Settings, label: string) =>
      `<label>${label}<br><input name="${name}" type="time" value="${esc(s[name])}" required></label>`;
    res.send(
      layout(
        'Configuração',
        form(
          '/config',
          `<section><h2>Dias ativos</h2>${days}</section>
<section><h2>Feriados / datas sem recolhimento</h2><p class="muted">Uma data por linha, formato AAAA-MM-DD.</p>
<textarea name="holidays" rows="6" cols="20">${esc(s.holidays.join('\n'))}</textarea></section>
<section><h2>Horários</h2><div class="grid">${t('announceTime', 'Aviso diário no grupo')}${t('deadlineTime', 'Prazo para voluntário')}${t('reminderTime', 'Lembrete na véspera (privado)')}${t('endOfDayTime', 'Fechamento do dia')}
<label>Tolerância de chamada após o prazo (min)<br><input name="lateCallGraceMinutes" type="number" min="5" max="240" value="${s.lateCallGraceMinutes}"></label>
<label><input type="checkbox" name="reminderEnabled" value="1"${s.reminderEnabled ? ' checked' : ''}> Enviar lembrete na véspera</label></div></section>
<button>Salvar configuração</button>`,
          '',
        ),
        flashOf(req),
      ),
    );
  });

  app.post(
    '/config',
    action('/config', (req) => {
      const b = body(req);
      const rawDays = b.days === undefined ? [] : Array.isArray(b.days) ? b.days : [b.days];
      const activeWeekdays = [...new Set(rawDays.map(Number))]
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        .sort() as Weekday[];
      const holidays = [
        ...new Set(
          str(b.holidays)
            .split(/[\s,;]+/)
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ].sort();
      const bad = holidays.filter((h) => !isISODate(h));
      if (bad.length) throw new Error(`Datas inválidas: ${bad.join(', ')}`);
      const times = ['announceTime', 'deadlineTime', 'reminderTime', 'endOfDayTime'] as const;
      const timeVals = Object.fromEntries(times.map((k) => [k, str(b[k]).slice(0, 5)])) as Record<(typeof times)[number], string>;
      for (const k of times) parseHHMM(timeVals[k]);
      if (parseHHMM(timeVals.announceTime) >= parseHHMM(timeVals.endOfDayTime)) throw new Error('Aviso deve ser antes do fechamento');
      const grace = Number(str(b.lateCallGraceMinutes));
      service.updateSettings({
        activeWeekdays,
        holidays,
        ...timeVals,
        reminderEnabled: str(b.reminderEnabled) === '1',
        lateCallGraceMinutes: Number.isInteger(grace) && grace >= 5 && grace <= 240 ? grace : 30,
      });
      return 'Configuração salva';
    }),
  );

  // ---------- grupo ----------
  app.get('/grupo', (req, res) => {
    const s = service.settings();
    const code = service.groupLinkCode();
    const bot = channel.getStatus().me;
    const cmd = code ? `/vincular_grupo${bot ? esc(bot) : ''} ${code.code}` : '';
    const until = code
      ? code.expiresAt.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
      : '';
    res.send(
      layout(
        'Grupo',
        `<section><h2>Grupo vinculado</h2><p>Atual: ${s.groupId ? `<strong>${esc(s.groupName ?? '')}</strong> <code>${esc(s.groupId)}</code>` : 'nenhum'}</p>
<p class="muted">O bot só lê comandos e só fala neste grupo (exceto o próprio vínculo e o lembrete no privado).</p>
${s.groupId ? form('/grupo/desvincular', `<button onclick="return confirm('Desvincular o grupo? O bot para de falar nele.')">Desvincular grupo</button>`) : ''}</section>
<section><h2>Vincular um grupo</h2>
<ol><li>Adicione o bot ao grupo do Telegram.</li><li>Gere um código abaixo (uso único, vale 15 minutos, invalidado após 5 tentativas erradas).</li>
<li>No grupo, envie o comando exibido.</li></ol>
${code ? `<p>Envie no grupo: <code style="font-size:18px">${cmd}</code> <span class="muted">(expira às ${esc(until)})</span></p>` : ''}
${form('/grupo/codigo', `<button>${code ? 'Gerar novo código' : 'Gerar código de vínculo'}</button>`)}</section>`,
        flashOf(req),
      ),
    );
  });
  app.post(
    '/grupo/codigo',
    action('/grupo', () => {
      service.generateGroupLinkCode();
      return 'Código gerado';
    }),
  );
  app.post(
    '/grupo/desvincular',
    action('/grupo', () => {
      service.unlinkGroup();
      return 'Grupo desvinculado';
    }),
  );

  // ---------- saldo de turnos ----------
  app.get('/saldo', (req, res) => {
    const month = monthKey(service.local().date);
    const people = service.repo.listParticipants();
    const last = service.repo.lastEffectiveDates();
    const stats = new Map(service.repo.dayStats(month).map((x) => [x.participantId, x]));
    const order = new Map(service.queue().map((p, i) => [p.id, i + 1]));
    const rows = people
      .filter((p) => p.status !== 'desligado' || (stats.get(p.id)?.days ?? 0) > 0)
      .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999) || a.position - b.position)
      .map((p) => {
        const st = stats.get(p.id);
        const bal =
          p.status === 'ativo'
            ? fmtBal(p.balance)
            : p.status === 'ferias'
              ? `<span class="muted">offset guardado</span> ${fmtBal(p.vacationOffset ?? 0)}`
              : '<span class="muted">-</span>';
        return `<tr><td>${order.get(p.id) ?? ''}</td><td>${esc(p.name)}</td><td>${esc(p.status)}</td><td>${bal}</td><td>${esc(last.get(p.id) ?? 'nunca')}</td><td>${st?.monthDays ?? 0}</td><td>${st?.days ?? 0}</td><td>${st?.covers ?? 0}</td></tr>`;
      })
      .join('');
    const preds = service
      .upcoming(10)
      .map((u) => `<tr><td>${esc(formatShort(u.date))}</td><td>${esc(u.record?.status === 'chamada' ? '?' : (u.participant?.name ?? '-'))}</td><td>${u.record ? esc(u.record.status) : 'previsto'}</td></tr>`)
      .join('');
    const rebases = service.repo
      .listRebases(30)
      .map(
        (r) =>
          `<tr><td>${esc(r.ts.slice(0, 16).replace('T', ' '))}</td><td>${esc(r.refDate)}</td><td>${r.mode}</td><td>${esc(r.reason)}</td><td>${esc(r.actor)}</td><td class="muted">${esc(r.detail.map((d) => `${d.name} ${d.before}→${d.after}`).join(', '))}</td></tr>`,
      )
      .join('');
    const debts = service.repo
      .debts()
      .map((d) => `<tr><td>${esc(d.covererName)}</td><td>${esc(d.coveredName)}</td><td>${d.count}</td></tr>`)
      .join('');
    const selectable = people.filter((p) => p.status !== 'desligado');
    res.send(
      layout(
        'Saldo',
        `<section><h2>Saldo de turnos</h2><p class="muted">${esc(QUEUE_RULE)} +1 para quem efetivamente fica com o dia (próprio ou cobertura).
Escalado = ativo de menor saldo; empate: quem recolheu há mais tempo, depois a ordem da lista. Nivelamento (subtrai a moda dos ativos) no início do mês, na entrada de alguém e na volta de férias/desligado.</p>
<table><tr><th>Fila</th><th>Nome</th><th>Status</th><th>Saldo</th><th>Último dia</th><th>Dias (${esc(monthLabel(month))})</th><th>Dias (total)</th><th>Coberturas</th></tr>${rows}</table></section>
<section><h2>Próximos escalados</h2><table><tr><th>Dia</th><th>Responsável</th><th>Situação</th></tr>${preds || '<tr><td colspan=3>Nenhum dia ativo.</td></tr>'}</table></section>
<section><h2>Ajuste manual de saldo</h2>${form(
          '/saldo/ajuste',
          `<select name="participantId">${selectable.map((p) => `<option value="${p.id}">${esc(p.name)}${p.status === 'ferias' ? ' (férias: ajusta o offset)' : ''}</option>`).join('')}</select>
<input name="delta" type="number" step="1" required placeholder="+/- turnos" style="width:90px">
<input name="reason" required maxlength="200" placeholder="Motivo (obrigatório)" size="30"> <button>Registrar</button>`,
          '',
        )}<p class="muted">Positivo empurra a pessoa para trás na fila; negativo traz para a frente. Fica registrado com o motivo.</p></section>
<section><h2>Nivelamentos</h2><table><tr><th>Quando (UTC)</th><th>Ref.</th><th>Moda subtraída</th><th>Motivo</th><th>Por</th><th>Saldos</th></tr>${rebases || '<tr><td colspan=6>Nenhum ainda.</td></tr>'}</table></section>
<section><h2>Quem cobriu quem</h2><table><tr><th>Cobriu</th><th>Coberto</th><th>Vezes</th></tr>${debts || '<tr><td colspan=3>Nenhuma cobertura ainda.</td></tr>'}</table></section>`,
        flashOf(req),
      ),
    );
  });
  app.post(
    '/saldo/ajuste',
    action('/saldo', (req) => {
      const b = body(req);
      const id = Number(str(b.participantId));
      if (!service.repo.getParticipant(id)) throw new Error('Participante inválido');
      service.adjustBalance(id, Number(str(b.delta)), str(b.reason), `admin:${opts.user}`);
      return 'Ajuste de saldo registrado';
    }),
  );

  // ---------- histórico ----------
  app.get('/historico', (req, res) => {
    const name = (id: number | null) => (id === null ? '-' : (service.repo.getParticipant(id)?.name ?? `#${id}`));
    const days = service.repo
      .listDays(60)
      .map(
        (d) =>
          `<tr><td>${esc(formatShort(d.date))} <span class="muted">${esc(d.date)}</span></td><td>${esc(name(d.originalId))}</td><td>${esc(name(d.holderId))}</td><td>${esc(d.status)}</td><td>${esc(d.callReason ?? '')}</td></tr>`,
      )
      .join('');
    const cov = service.repo
      .listCoverages(60)
      .map(
        (c) =>
          `<tr><td>${esc(c.date)}</td><td>${esc(name(c.covererId))}</td><td>${esc(name(c.coveredId))}</td><td>${esc(c.mode)}</td><td>${esc(c.reason)}</td><td>${esc(c.status)}</td></tr>`,
      )
      .join('');
    const bal = service.repo
      .listBalanceLog(150)
      .map(
        (p) =>
          `<tr><td>${esc(p.createdAt.slice(0, 16).replace('T', ' '))}</td><td>${esc(p.refDate)}</td><td>${esc(name(p.participantId))}</td><td>${p.delta > 0 ? '+' : ''}${p.delta}</td><td>${p.balanceAfter}</td><td>${esc(p.kind)}</td><td>${esc(p.reason)}</td><td>${esc(p.actor)}</td></tr>`,
      )
      .join('');
    const ev = service.repo
      .listEvents(80)
      .map((e) => `<tr><td>${esc(e.ts.slice(0, 19).replace('T', ' '))}</td><td>${esc(e.type)}</td><td><code>${esc(e.detail)}</code></td></tr>`)
      .join('');
    res.send(
      layout(
        'Histórico',
        `<section><h2>Dias</h2><table><tr><th>Data</th><th>Escalado</th><th>Ficou com</th><th>Status</th><th>Ocorrência</th></tr>${days}</table></section>
<section><h2>Coberturas</h2><table><tr><th>Data</th><th>Cobriu</th><th>Coberto</th><th>Modo</th><th>Motivo</th><th>Status</th></tr>${cov}</table></section>
<section><h2>Saldo (auditoria)</h2><table><tr><th>Quando (UTC)</th><th>Ref.</th><th>Quem</th><th>Delta</th><th>Saldo após</th><th>Tipo</th><th>Motivo</th><th>Por</th></tr>${bal}</table></section>
<section><h2>Eventos</h2><table><tr><th>Quando (UTC)</th><th>Tipo</th><th>Detalhe</th></tr>${ev}</table></section>`,
        flashOf(req),
      ),
    );
  });

  app.post(
    '/dia/:date/desfazer',
    action('/', (req) => {
      const date = String(req.params.date);
      if (!isISODate(date)) throw new Error('Data inválida');
      service.cancelDay(date);
      return `Escala de ${date} desfeita e data marcada como feriado`;
    }),
  );

  return app.listen(opts.port, opts.host);
}
