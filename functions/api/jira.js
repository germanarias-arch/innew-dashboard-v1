// POST /api/jira — Proxy de SÓLO LECTURA a Jira Cloud. Cloudflare Pages Function.
// Mismo patrón que /api/hubspot: requiere sesión válida (cookie) y el token vive sólo acá (env),
// nunca en el navegador. El browser no puede pegarle a Jira directo por CORS; esto lo resuelve.
//
// Creado el 2026-09-24. Reemplaza al snapshot que escribía el task `jira-radar-soporte` en la
// property `jira_tickets` de HubSpot: con esto el dashboard lee la cola de soporte EN VIVO, no
// una foto de hasta 2 h, no depende de un task que puede estar apagado (el de horas lo estuvo un
// mes sin que nadie se enterara) y deja de meter un blob JSON adentro del CRM.
//
// 🚨 SÓLO LECTURA, por decisión de German (23/09). Nada de comentar ni mover estados desde el
// dashboard: en los portales de Innew **un comentario que no sea interno le llega al cliente por
// mail y borrarlo NO lo deshace**. Un botón mal apretado acá se convierte en un mail al cliente.
//
// Variables de entorno (las carga German en Cloudflare → Settings → Environment variables):
//   JIRA_EMAIL     = german.arias@innew.la
//   JIRA_TOKEN     = API token de https://id.atlassian.com/manage-profile/security/api-tokens
//   JIRA_CLOUD_ID  = ccccd0be-abcf-4c5b-84b3-090d76e6efef   ← SÓLO si el token es CON SCOPES
//   JIRA_BASE      = https://innewla.atlassian.net          (opcional, override del dominio)
//
// 🪤 ATLASSIAN TIENE DOS TIPOS DE TOKEN Y **USAN URLs DISTINTAS**. Es el error más fácil de
// cometer acá, porque los dos se generan en la misma pantalla y se ven igual:
//   · **Con scopes** (el que Atlassian recomienda, y el que conviene): hay que pegarle a
//     `https://api.atlassian.com/ex/jira/{cloudId}`. Contra el dominio del sitio da 401.
//   · **Sin scopes** (clásico): se le pega a `https://innewla.atlassian.net`.
// Por eso el destino se decide solo: **si hay `JIRA_CLOUD_ID`, va por api.atlassian.com**.
// Cargar la variable equivocada no rompe nada silenciosamente — da un 401 que el catch de
// abajo traduce a "revisá las credenciales", con el destino que se usó escrito al lado.
//
// ⏳ **Los tokens de Atlassian VENCEN — máximo 365 días, y por defecto 1 año.** El día que
// venza, las dos vistas se caen con 401. No hay forma de evitarlo desde acá: lo único que se
// puede hacer es que el mensaje diga exactamente eso en vez de "error del backend".
import { verify, getCookie, COOKIE } from "../../lib/session.js";

const JIRA_DEFAULT = "https://innewla.atlassian.net";

/* Base efectiva + una etiqueta para el diagnóstico. Devolver también QUÉ camino se eligió es
   lo que convierte un 401 mudo en un error accionable. */
function jiraBase(env) {
  if (env.JIRA_CLOUD_ID) return { url: "https://api.atlassian.com/ex/jira/" + env.JIRA_CLOUD_ID, modo: "token con scopes (api.atlassian.com)" };
  return { url: (env.JIRA_BASE || JIRA_DEFAULT).replace(/\/+$/, ""), modo: "token sin scopes (dominio del sitio)" };
}

/* Proyectos permitidos. Es una LISTA BLANCA a propósito: este proxy lleva un token con acceso a
   todo el Jira de Innew, así que aceptar un JQL libre desde el navegador lo convertiría en una
   llave maestra del sitio. El front elige entre estos; no puede inventar otro.
   Fuente: `memory/jira-innew.md` (mapa cuenta → proyecto, verificado 2026-09-22). */
const PROY_GERMAN = ["CAB", "VANA", "ASSATEX", "NA", "PERSONALPY", "BREMEN", "PLM", "PMP", "LH", "PETENATTI", "BILDER"];
const PROY_JENNY = ["ROUGE", "DRICCO", "DAYTONA", "VALENET", "PFDP", "GUATA", "GUATAFS", "PRTL", "TRAMONTINA", "ANTUAN", "CORMORAN", "PEC", "PST", "PSA"];
const PROY_OK = {};
PROY_GERMAN.concat(PROY_JENNY).forEach(k => { PROY_OK[k] = 1; });

/* Campos mínimos. 🪤 El payload de Jira pesa ~2 KB por issue aunque pidas poco: el objeto
   `project` viene entero y repetido en cada uno. Pedir de más acá se paga en cada apertura
   de la vista, así que se piden 8 campos y se devuelve un objeto plano y chico. */
const FIELDS = ["key", "summary", "status", "priority", "assignee", "created", "updated", "duedate"];

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

/* Basic auth de Jira Cloud: base64("email:token"). `btoa` existe en el runtime de Workers.
   ⚠️ No usar el token como Bearer: Jira Cloud rechaza eso con un 401 que no explica nada. */
function authHeader(email, token) {
  return "Basic " + btoa(email + ":" + token);
}

async function jiraFetch(env, path, body) {
  const base = jiraBase(env).url;
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Authorization": authHeader(env.JIRA_EMAIL, env.JIRA_TOKEN),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let js; try { js = text ? JSON.parse(text) : {}; } catch (e) { js = { raw: text }; }
  if (!r.ok) {
    /* El mensaje real de Jira viaja ENTERO hasta la pantalla. Recortarlo es una decisión de
       producto disfrazada de formato, y el corte siempre cae donde está la información
       (regla ganada a los golpes el 22/09 con el error de HubSpot truncado en 140 chars). */
    const detalle = (js && (js.errorMessages || []).join(" · ")) || (js && js.message) || text;
    const err = new Error("Jira " + r.status + ": " + detalle);
    err.status = r.status;
    throw err;
  }
  return js;
}

/* Aplana un issue a lo que el dashboard necesita, con las MISMAS claves cortas que usaba el
   snapshot — así el motor del front (`jtDeCuenta`) no cambia y las dos vistas siguen andando.

   🪤 `m` = contenedor de worklog mensual, y es el campo que evita el bug que estaba en
   producción: el 37% de los tickets abiertos de German son sus mensuales de "Reuniones &
   minutas" y "Gestión…Reportería". Contarlos como cola infla cada cuenta en +1/+2 de forma
   constante — La Herramienta figuraba con 2 tickets abiertos y en realidad no tiene ninguno.
   El patrón NO es uniforme entre cuentas (en PMP va sin `|` y sin `&`, y conviven
   "Soporte & Evolutivo" con "Soluciones & Evolutivo"), así que se detecta por palabras
   sueltas sobre el texto normalizado, nunca por match exacto. */
function esAdmin(summary) {
  const s = String(summary || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (s.includes("reunion") && s.includes("minuta")) || (s.includes("gestion") && s.includes("reporter"));
}
function plano(it) {
  const f = (it && it.fields) || {};
  return {
    k: it.key,
    r: String(f.summary || "").slice(0, 90),
    s: (f.status && f.status.name) || "",                    // nombre LITERAL: los 8 estados abiertos
    p: f.priority ? Number(f.priority.id) : null,            // ID, no nombre: los nombres llevan emoji
    a: (f.assignee && f.assignee.displayName) || "",
    c: f.created ? String(f.created).slice(0, 10) : null,
    u: f.updated ? String(f.updated).slice(0, 10) : null,
    d: f.duedate || null,
    m: esAdmin(f.summary) ? 1 : 0
  };
}

/* La única operación: los tickets abiertos de un set de proyectos permitidos.
   No existe un `op` que acepte JQL libre, y es deliberado (ver la nota de la lista blanca). */
async function doAbiertos(env, args) {
  const pedidos = Array.isArray(args && args.proyectos) ? args.proyectos : PROY_GERMAN;
  const keys = pedidos.map(x => String(x || "").toUpperCase().trim()).filter(k => PROY_OK[k]);
  if (!keys.length) throw Object.assign(new Error("Ningún proyecto válido en la consulta"), { status: 400 });

  const jql = "project in (" + keys.join(", ") + ") AND statusCategory != Done ORDER BY updated ASC";
  /* `/rest/api/3/search/jql` es el endpoint vigente; el viejo `/search` está deprecado y
     empezó a devolver 410 en 2025. `maxResults` tope 100 por página. */
  const out = [];
  let token = null, vueltas = 0;
  do {
    const body = { jql: jql, fields: FIELDS, maxResults: 100 };
    if (token) body.nextPageToken = token;
    const r = await jiraFetch(env, "/rest/api/3/search/jql", body);
    (r.issues || []).forEach(it => out.push(plano(it)));
    token = r.nextPageToken || null;
    vueltas++;
    /* Guarda dura: sin esto, un `nextPageToken` que Jira devuelva siempre igual deja el worker
       girando hasta que Cloudflare lo mata, y el síntoma en pantalla sería "el dashboard no
       carga" sin ninguna pista. 10 vueltas = 1.000 issues, muy por encima de lo real (38). */
  } while (token && vueltas < 10);

  return { ts: new Date().toISOString(), proyectos: keys, truncado: !!token, t: out };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const SECRET = env.SESSION_SECRET || "cambia-esto-en-cloudflare";
  const sess = await verify(getCookie(request, COOKIE), SECRET);
  if (!sess) return json({ error: "No autenticado" }, 401);

  /* Falta de config ≠ error del servidor: se dice QUÉ falta y DÓNDE se carga, para que el
     mensaje en pantalla sea accionable en vez de un 500 mudo. */
  if (!env.JIRA_EMAIL || !env.JIRA_TOKEN) {
    return json({
      error: "Faltan las variables de Jira en Cloudflare: " +
        [!env.JIRA_EMAIL ? "JIRA_EMAIL" : "", !env.JIRA_TOKEN ? "JIRA_TOKEN" : ""].filter(Boolean).join(" y ") +
        ". Se cargan en Cloudflare Pages → el proyecto → Settings → Environment variables."
    }, 500);
  }

  try {
    const parsed = await request.json().catch(() => ({}));
    const op = parsed.op || "";
    if (op === "abiertos") return json(await doAbiertos(env, parsed.args || {}), 200);
    return json({ error: "Operación de Jira no soportada: " + op }, 400);
  } catch (e) {
    /* 401 de Jira = token vencido, mal copiado, o apuntando al destino equivocado. Hay que
       decirlo con ese nombre y mostrar POR DÓNDE salió: un "500" genérico manda a buscar el
       problema al dashboard cuando está en las credenciales, y sin el destino no se distingue
       "token vencido" de "token con scopes pegándole al dominio del sitio". */
    const st = (e.status === 401 || e.status === 403 || e.status === 404) ? e.status : 500;
    const extra = (e.status === 401 || e.status === 403)
      ? " · Salió por: " + jiraBase(env).modo + ". Revisá en Cloudflare JIRA_EMAIL, JIRA_TOKEN y si el token tiene scopes que esté cargada JIRA_CLOUD_ID (y si no tiene, que NO esté). Los tokens de Atlassian vencen: máximo 365 días."
      : "";
    return json({ error: e.message + extra }, st);
  }
}
