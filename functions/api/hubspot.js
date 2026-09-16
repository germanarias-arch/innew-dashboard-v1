// POST /api/hubspot — Proxy a HubSpot. Reemplaza lo que en Cowork hace el conector MCP.
// Cloudflare Pages Function (reemplaza netlify/functions/hubspot.js).
// Requiere sesión válida (cookie). El token de HubSpot vive solo acá (env), nunca en el navegador.
import { verify, getCookie, COOKIE } from "../../lib/session.js";

const HS = "https://api.hubapi.com";
const OP = ["EQ","NEQ","LT","LTE","GT","GTE","BETWEEN","IN","NOT_IN","HAS_PROPERTY","NOT_HAS_PROPERTY","CONTAINS_TOKEN","NOT_CONTAINS_TOKEN"];

// Reintento ante 429 (rate limit) y 5xx transitorios de HubSpot.
// HubSpot limita el endpoint /search por SEGUNDO (policy SECONDLY, unas pocas requests/s).
// El dashboard dispara muchas búsquedas en paralelo en el boot y en cada refresh: si se pasa,
// HubSpot devuelve 429 y antes el panel entero moría con "Error del backend (500)".
// Un 429 NO es un error de datos: es "vení dentro de un rato". Por eso se reintenta acá,
// transparente para el front. Esperar es tiempo de reloj, no CPU: no cuenta contra el
// límite de CPU del worker de Cloudflare.
const HS_RETRIES = 4;                     // 4 intentos = hasta ~3.5s de espera acumulada
const HS_BACKOFF = [300, 800, 1800];      // ms antes del intento 2, 3 y 4

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function hsFetch(token, path, opts) {
  opts = opts || {};
  let last = null;
  for (let intento = 0; intento < HS_RETRIES; intento++) {
    const r = await fetch(HS + path, Object.assign({}, opts, {
      headers: Object.assign({ "Authorization": "Bearer " + token, "Content-Type": "application/json" }, opts.headers || {})
    }));
    const text = await r.text();
    let js; try { js = text ? JSON.parse(text) : {}; } catch (e) { js = { raw: text }; }
    if (r.ok) return js;

    const err = new Error("HubSpot " + r.status + ": " + text.slice(0, 300));
    err.status = r.status;
    last = err;

    // Sólo reintentamos lo que puede salir bien si esperamos. Un 400/401/404 no mejora con tiempo.
    const reintentable = r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504;
    if (!reintentable || intento === HS_RETRIES - 1) throw err;

    // Si HubSpot dice cuánto esperar (Retry-After, en segundos), le hacemos caso.
    const ra = parseFloat(r.headers.get("Retry-After") || "");
    const base = (ra > 0 && ra <= 10) ? ra * 1000 : HS_BACKOFF[intento];
    await sleep(base + Math.floor(Math.random() * 200)); // jitter: evita que N workers reintenten al unísono
  }
  throw last;
}
function toolName(t) { return (t || "").split("__").pop(); }

async function doSearch(token, args) {
  const objectType = args.objectType;
  let assocIds = null;
  for (const g of (args.filterGroups || [])) {
    if (g.associatedWith && g.associatedWith.length) {
      const aw = g.associatedWith[0];
      const dealId = (aw.objectIdValues || [])[0];
      const assoc = await hsFetch(token, "/crm/v4/objects/" + aw.objectType + "/" + dealId + "/associations/" + objectType + "?limit=100");
      assocIds = (assoc.results || []).map(x => String(x.toObjectId || (x.to && x.to.id)));
    }
  }
  const body = {
    filterGroups: (args.filterGroups || []).map(g => ({
      filters: (g.filters || []).map(f => {
        const o = { propertyName: f.propertyName, operator: OP.indexOf(f.operator) >= 0 ? f.operator : "EQ" };
        if (f.value !== undefined) o.value = f.value;
        if (f.values !== undefined) o.values = f.values;
        if (f.highValue !== undefined) o.highValue = f.highValue;
        return o;
      })
    })),
    properties: args.properties || [],
    limit: args.limit || 100
  };
  if (args.sorts) body.sorts = args.sorts.map(s => ({ propertyName: s.propertyName, direction: s.direction }));
  if (args.offset) body.after = String(args.offset);
  if (assocIds) {
    if (!assocIds.length) return { results: [], total: 0 };
    const idFilter = { propertyName: "hs_object_id", operator: "IN", values: assocIds };
    if (!body.filterGroups.length) body.filterGroups = [{ filters: [idFilter] }];
    else body.filterGroups.forEach(g => g.filters.push(idFilter));
  }
  const res = await hsFetch(token, "/crm/v3/objects/" + objectType + "/search", { method: "POST", body: JSON.stringify(body) });
  return {
    results: (res.results || []).map(r => ({ id: r.id, properties: r.properties })),
    total: res.total,
    offset: res.paging && res.paging.next ? Number(res.paging.next.after) : undefined
  };
}

async function doManage(token, args) {
  const out = {};
  if (args.createRequest && args.createRequest.objects) {
    const results = [];
    for (const o of args.createRequest.objects) {
      const created = await hsFetch(token, "/crm/v3/objects/" + o.objectType, { method: "POST", body: JSON.stringify({ properties: o.properties || {} }) });
      if (o.associations) {
        for (const a of o.associations) {
          await hsFetch(token, "/crm/v4/objects/" + o.objectType + "/" + created.id + "/associations/default/" + a.targetObjectType + "/" + a.targetObjectId, { method: "PUT", body: "[]" });
        }
      }
      results.push({ objectType: o.objectType, objectId: Number(created.id), object: { id: created.id } });
    }
    out.createResults = { results: results, summary: { created: results.length, failed: 0 } };
    out.results = results; // top-level: lo que lee genExtractNewId en el front (objectId/id del nuevo deal)
  }
  if (args.updateRequest && args.updateRequest.objects) {
    const results = [];
    for (const o of args.updateRequest.objects) {
      await hsFetch(token, "/crm/v3/objects/" + o.objectType + "/" + o.objectId, { method: "PATCH", body: JSON.stringify({ properties: o.properties || {} }) });
      if (o.associations) {
        for (const a of o.associations) {
          await hsFetch(token, "/crm/v4/objects/" + o.objectType + "/" + o.objectId + "/associations/default/" + a.targetObjectType + "/" + a.targetObjectId, { method: "PUT", body: "[]" });
        }
      }
      results.push({ objectType: o.objectType, objectId: o.objectId });
    }
    out.updateResults = { results: results, summary: { updated: results.length, failed: 0 } };
  }
  return out;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
}


/* ---- Conversations (bandeja del chat del sitio) — SÓLO LECTURA -------------------------
   Agregada el 2026-09-16, cuando German sumó el scope `conversations.read` a la app privada.
   Hasta acá el dashboard sólo podía mostrar el CONTACTO que deja el chat, nunca el texto.

   Es una rama ACOTADA a dos operaciones de lectura, no un passthrough genérico: este proxy
   lleva el token de HubSpot y un `path` libre desde el navegador convertiría al dashboard en
   una llave maestra del portal. Si mañana hace falta responder desde acá, se agrega una
   operación nueva explícita (y requiere `conversations.write`, que hoy NO está).

   Ojo con `threadStatus`: la doc de HubSpot exige mandarlo cuando se filtra por
   `associatedContactId`, y sólo acepta OPEN o CLOSED — no hay "ambos". Por eso se piden las
   dos y se fusionan; si no, los hilos ya cerrados desaparecerían sin aviso. */
async function doConversations(token, args) {
  const op = (args && args.op) || "";
  const q = n => encodeURIComponent(String(n));

  if (op === "threads") {
    const cid = String((args && args.contactId) || "");
    if (!/^\d+$/.test(cid)) throw Object.assign(new Error("contactId inválido"), { status: 400 });
    const base = "/conversations/v3/conversations/threads?associatedContactId=" + q(cid) + "&limit=100&threadStatus=";
    const [abiertos, cerrados] = await Promise.all([
      hsFetch(token, base + "OPEN").catch(e => { if (e.status === 404) return { results: [] }; throw e; }),
      hsFetch(token, base + "CLOSED").catch(e => { if (e.status === 404) return { results: [] }; throw e; })
    ]);
    const todos = [].concat(abiertos.results || [], cerrados.results || []);
    // Dedupe por id: un hilo no puede estar en los dos estados, pero no cuesta nada blindarlo.
    const vistos = {}, out = [];
    todos.forEach(t => { if (t && t.id && !vistos[t.id]) { vistos[t.id] = 1; out.push(t); } });
    out.sort((a, b) => String(b.latestMessageTimestamp || b.createdAt || "").localeCompare(String(a.latestMessageTimestamp || a.createdAt || "")));
    return { results: out, total: out.length };
  }

  if (op === "messages") {
    const tid = String((args && args.threadId) || "");
    if (!/^\d+$/.test(tid)) throw Object.assign(new Error("threadId inválido"), { status: 400 });
    const r = await hsFetch(token, "/conversations/v3/conversations/threads/" + q(tid) + "/messages?limit=100");
    return { results: r.results || [] };
  }

  throw Object.assign(new Error("Operación de conversations no soportada: " + op), { status: 400 });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const TOKEN = env.HUBSPOT_TOKEN;
  const SECRET = env.SESSION_SECRET || "cambia-esto-en-cloudflare";
  const sess = await verify(getCookie(request, COOKIE), SECRET);
  if (!sess) return json({ error: "No autenticado" }, 401);
  if (!TOKEN) return json({ error: "Falta HUBSPOT_TOKEN en el entorno" }, 500);
  try {
    const parsed = await request.json().catch(() => ({}));
    const name = toolName(parsed.tool);
    const args = parsed.args;
    let data;
    if (name === "search_crm_objects") data = await doSearch(TOKEN, args);
    else if (name === "manage_crm_objects") data = await doManage(TOKEN, args);
    else if (name === "conversations") data = await doConversations(TOKEN, args);
    else return json({ error: "Tool no soportada: " + name }, 400);
    return json(data, 200);
  } catch (e) {
    // El 429 se propaga tal cual (no como 500) para que el front lo reconozca y reintente
    // en vez de tirarle a German un "Error del backend" que parece un bug del dashboard.
    const st = (e.status === 404 || e.status === 429) ? e.status : 500;
    return json({ error: e.message }, st);
  }
}
