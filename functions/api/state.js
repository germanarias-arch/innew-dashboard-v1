// GET / PUT /api/state — Estado del dashboard (lo que antes vivía SOLO en localStorage).
// Cloudflare Pages Function. Guarda en Workers KV (binding DASH_STATE), en UN documento COMPARTIDO
// por todo el equipo de Innew (cualquiera logueado lee y escribe el mismo estado).
// Objetivo: que Base contratada, snapshots, matriz de producto, fuentes, target, agenda, marcadores, etc.
// sobrevivan cambios de dominio, de navegador y de máquina.
//
// GET  /api/state            -> { state: {...}, updatedAt: 1234567890, key: "email" }
// PUT  /api/state            -> body { state: {...}, base?: <updatedAt que tenía el cliente> }
//                               201 { ok:true, updatedAt } | 409 { conflict:true, state, updatedAt }
// POST /api/state            -> alias de PUT (por si algún cliente no manda PUT)
import { verify, getCookie, COOKIE } from "../../lib/session.js";

const PREFIX = "dash:v1:";
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

// COMPARTIDO: TODO el equipo de Innew lee y escribe el MISMO documento.
// (Decisión de German 2026-08-05: alcance = todo dashComercial_v2, permisos = todos los de Innew.)
// El email/nombre del último que guardó queda registrado en el doc como rastro de auditoría.
// Se puede volver a per-usuario cambiando esto por: PREFIX + sess.email.toLowerCase()
const SHARED_KEY = PREFIX + "innew";

function keyFor(sess) {
  return SHARED_KEY;
}

export async function onRequestGet(context) {
  const sess = await session(context);
  if (!sess) return json({ error: "No autenticado" }, 401);
  const kv = kvOf(context.env);
  if (!kv) return json({ error: "KV no configurado (falta el binding DASH_STATE)" }, 501);
  try {
    const raw = await kv.get(keyFor(sess));
    if (!raw) return json({ state: null, updatedAt: 0, key: SHARED_KEY, shared: true }, 200);
    let doc; try { doc = JSON.parse(raw); } catch (e) { doc = null; }
    if (!doc || typeof doc !== "object") return json({ state: null, updatedAt: 0, key: SHARED_KEY, shared: true }, 200);
    return json({
      state: doc.state || null,
      updatedAt: doc.updatedAt || 0,
      key: SHARED_KEY,
      shared: true,
      by: doc.email || "",
      byName: doc.name || ""
    }, 200);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function save(context) {
  const sess = await session(context);
  if (!sess) return json({ error: "No autenticado" }, 401);
  const kv = kvOf(context.env);
  if (!kv) return json({ error: "KV no configurado (falta el binding DASH_STATE)" }, 501);

  let body;
  try { body = await context.request.json(); } catch (e) { return json({ error: "JSON inválido" }, 400); }
  if (!body || typeof body !== "object" || !body.state || typeof body.state !== "object") {
    return json({ error: "Falta 'state' (objeto)" }, 400);
  }

  const key = keyFor(sess);

  // Control de concurrencia optimista: si el cliente dice desde qué versión escribe
  // y en KV hay una más nueva, devolvemos 409 con el estado del server (no pisamos).
  if (body.base !== undefined && body.base !== null) {
    try {
      const prevRaw = await kv.get(key);
      if (prevRaw) {
        const prev = JSON.parse(prevRaw);
        const prevAt = prev.updatedAt || 0;
        if (prevAt > Number(body.base || 0)) {
          return json({
            conflict: true,
            state: prev.state || null,
            updatedAt: prevAt,
            by: prev.email || "",
            byName: prev.name || ""
          }, 409);
        }
      }
    } catch (e) { /* si no se puede leer el previo, seguimos y escribimos */ }
  }

  const updatedAt = Date.now();
  const doc = JSON.stringify({
    state: body.state,
    updatedAt: updatedAt,
    email: sess.email,
    name: sess.name || ""
  });
  if (doc.length > MAX_BYTES) return json({ error: "Estado demasiado grande (" + doc.length + " bytes)" }, 413);

  try {
    await kv.put(key, doc);
    return json({ ok: true, updatedAt: updatedAt, by: sess.email, byName: sess.name || "" }, 200);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export async function onRequestPut(context)  { return save(context); }
export async function onRequestPost(context) { return save(context); }
