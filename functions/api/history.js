// GET / POST /api/history — Histórico semanal del pipeline (append-only).
// Cloudflare Pages Function. Vive en el MISMO Workers KV que /api/state (binding DASH_STATE),
// con otro prefijo de key: así no hace falta ningún binding ni env var nueva.
//
// Diferencia de fondo con /api/state:
//   /api/state   -> UNA key que se PISA en cada guardado (el estado vigente).
//   /api/history -> UNA key NUEVA E INMUTABLE por semana. Nunca se sobrescribe.
// Es lo que permite responder "lo que proyectaba en agosto para septiembre, ¿se cumplió?".
//
// POST /api/history                 -> body { week?: "2026-W34", snapshot: {...}, force?: true }
//                                      201 { ok:true, week, createdAt } | 409 { exists:true, week, createdAt, by }
// GET  /api/history                 -> { weeks: [{ week, createdAt, by, deals }] }   (índice)
// GET  /api/history?week=2026-W34   -> { week, createdAt, by, snapshot }
// GET  /api/history?from=&to=       -> { items: [{ week, createdAt, by, snapshot }] }
// GET  /api/history?format=csv&...  -> text/csv (una fila por deal por semana)
//
// NO hay DELETE: el histórico es append-only por diseño. Si hay que corregir una semana,
// se re-postea con ?force=1 (queda registrado quién y cuándo la pisó).
import { verify, getCookie, COOKIE } from "../../lib/session.js";

const PREFIX = "dash:hist:";
const MAX_BYTES = 20 * 1024 * 1024; // KV admite 25MB por valor; dejamos margen.

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

async function session(context) {
  const SECRET = context.env.SESSION_SECRET || "cambia-esto-en-cloudflare";
  return await verify(getCookie(context.request, COOKIE), SECRET);
}

function kvOf(env) {
  return env.DASH_STATE || null;
}

// Semana ISO-8601 (lunes a domingo), formato "2026-W34".
// El front manda la suya, pero el back calcula la propia como default y para validar.
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Jueves de esta semana define el año ISO.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

const WEEK_RE = /^\d{4}-W\d{2}$/;

// ---------------------------------------------------------------- GET

export async function onRequestGet(context) {
  const sess = await session(context);
  if (!sess) return json({ error: "No autenticado" }, 401);
  const kv = kvOf(context.env);
  if (!kv) return json({ error: "KV no configurado (falta el binding DASH_STATE)" }, 501);

  const url = new URL(context.request.url);
  const week = url.searchParams.get("week");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const format = (url.searchParams.get("format") || "").toLowerCase();

  try {
    // --- Una semana puntual
    if (week) {
      if (!WEEK_RE.test(week)) return json({ error: "week inválida (formato 2026-W34)" }, 400);
      const raw = await kv.get(PREFIX + week);
      if (!raw) return json({ error: "No hay snapshot para " + week }, 404);
      const doc = JSON.parse(raw);
      if (format === "csv") return csvResponse([doc], week + ".csv");
      return json(doc, 200);
    }

    // --- Índice / rango: listamos las keys del prefijo.
    // 52 semanas por año contra el límite de 1000 de kv.list() -> no hace falta paginar,
    // pero dejamos el cursor por si el histórico crece más de lo previsto.
    const keys = [];
    let cursor;
    do {
      const page = await kv.list({ prefix: PREFIX, cursor: cursor });
      for (const k of page.keys) keys.push(k.name.slice(PREFIX.length));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    keys.sort();

    const inRange = keys.filter(w => (!from || w >= from) && (!to || w <= to));

    // Sin rango ni csv -> índice liviano (no traemos los snapshots enteros)
    if (!from && !to && format !== "csv") {
      const weeks = [];
      for (const w of keys) {
        const raw = await kv.get(PREFIX + w);
        if (!raw) continue;
        let doc; try { doc = JSON.parse(raw); } catch (e) { continue; }
        const deals = (doc.snapshot && Array.isArray(doc.snapshot.deals)) ? doc.snapshot.deals.length : 0;
        weeks.push({ week: w, createdAt: doc.createdAt || 0, by: doc.email || "", deals: deals });
      }
      return json({ weeks: weeks }, 200);
    }

    const items = [];
    for (const w of inRange) {
      const raw = await kv.get(PREFIX + w);
      if (!raw) continue;
      try { items.push(JSON.parse(raw)); } catch (e) { /* semana corrupta: la salteamos */ }
    }
    if (format === "csv") return csvResponse(items, "historico-pipeline.csv");
    return json({ items: items }, 200);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ---------------------------------------------------------------- CSV

// Campos por deal. Son los que German pidió para poder cortar el histórico por
// owner / producto / país / fuente y medir accuracy de forecast contra probabilidad.
// Tienen que coincidir con las claves que arma histBuildSnapshot() en el dashboard.
const CSV_COLS = [
  "week", "createdAt", "dealId", "dealname",
  "owner", "producto", "pais", "lead_source", "fuente", "partner",
  "probabilidad", "etapa", "etapaId", "monto", "cuotaMes",
  "closedate", "createdate", "oculto"
];

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvResponse(items, filename) {
  const lines = [CSV_COLS.join(",")];
  for (const doc of items) {
    const week = doc.week || "";
    const createdAt = doc.createdAt ? new Date(doc.createdAt).toISOString() : "";
    const deals = (doc.snapshot && Array.isArray(doc.snapshot.deals)) ? doc.snapshot.deals : [];
    for (const d of deals) {
      const row = CSV_COLS.map(c => {
        if (c === "week") return week;
        if (c === "createdAt") return createdAt;
        return csvEscape(d[c]);
      });
      lines.push(row.join(","));
    }
  }
  // BOM para que Excel/Sheets en es-AR no rompa los acentos.
  return new Response("﻿" + lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + filename + '"',
      "Cache-Control": "no-store"
    }
  });
}

// ---------------------------------------------------------------- POST

async function save(context) {
  const sess = await session(context);
  if (!sess) return json({ error: "No autenticado" }, 401);
  const kv = kvOf(context.env);
  if (!kv) return json({ error: "KV no configurado (falta el binding DASH_STATE)" }, 501);

  let body;
  try { body = await context.request.json(); } catch (e) { return json({ error: "JSON inválido" }, 400); }
  if (!body || typeof body !== "object" || !body.snapshot || typeof body.snapshot !== "object") {
    return json({ error: "Falta 'snapshot' (objeto)" }, 400);
  }

  const week = body.week || isoWeek(new Date());
  if (!WEEK_RE.test(week)) return json({ error: "week inválida (formato 2026-W34)" }, 400);
  const key = PREFIX + week;

  const url = new URL(context.request.url);
  const force = body.force === true || url.searchParams.get("force") === "1";

  // Append-only: si la semana ya existe, NO la pisamos salvo force explícito.
  try {
    const prevRaw = await kv.get(key);
    if (prevRaw && !force) {
      let prev = {}; try { prev = JSON.parse(prevRaw); } catch (e) {}
      return json({
        exists: true,
        week: week,
        createdAt: prev.createdAt || 0,
        by: prev.email || "",
        byName: prev.name || ""
      }, 409);
    }
  } catch (e) { /* si no se puede leer el previo, seguimos */ }

  const createdAt = Date.now();
  const doc = JSON.stringify({
    week: week,
    createdAt: createdAt,
    email: sess.email,
    name: sess.name || "",
    snapshot: body.snapshot
  });
  if (doc.length > MAX_BYTES) return json({ error: "Snapshot demasiado grande (" + doc.length + " bytes)" }, 413);

  try {
    await kv.put(key, doc);
    return json({ ok: true, week: week, createdAt: createdAt, by: sess.email }, 201);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) { return save(context); }
export async function onRequestPut(context)  { return save(context); }
