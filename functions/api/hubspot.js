// POST /api/hubspot — Proxy a HubSpot. Reemplaza lo que en Cowork hace el conector MCP.
// Cloudflare Pages Function (reemplaza netlify/functions/hubspot.js).
// Requiere sesión válida (cookie). El token de HubSpot vive solo acá (env), nunca en el navegador.
import { verify, getCookie, COOKIE } from "../../lib/session.js";

const HS = "https://api.hubapi.com";
const OP = ["EQ","NEQ","LT","LTE","GT","GTE","BETWEEN","IN","NOT_IN","HAS_PROPERTY","NOT_HAS_PROPERTY","CONTAINS_TOKEN","NOT_CONTAINS_TOKEN"];

async function hsFetch(token, path, opts) {
  opts = opts || {};
  const r = await fetch(HS + path, Object.assign({}, opts, {
    headers: Object.assign({ "Authorization": "Bearer " + token, "Content-Type": "application/json" }, opts.headers || {})
  }));
  const text = await r.text();
  let js; try { js = text ? JSON.parse(text) : {}; } catch (e) { js = { raw: text }; }
  if (!r.ok) { const err = new Error("HubSpot " + r.status + ": " + text.slice(0, 300)); err.status = r.status; throw err; }
  return js;
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
    else return json({ error: "Tool no soportada: " + name }, 400);
    return json(data, 200);
  } catch (e) {
    return json({ error: e.message }, e.status === 404 ? 404 : 500);
  }
}
