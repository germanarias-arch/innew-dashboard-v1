// Proxy a HubSpot. Reemplaza lo que en Cowork hacía el conector MCP.
// Requiere sesión válida (cookie). El token de HubSpot vive solo acá (env), nunca en el navegador.
const { verify, getCookie, COOKIE } = require("./_session");

const HS = "https://api.hubapi.com";
const TOKEN = process.env.HUBSPOT_TOKEN;
const OP = ["EQ","NEQ","LT","LTE","GT","GTE","BETWEEN","IN","NOT_IN","HAS_PROPERTY","NOT_HAS_PROPERTY","CONTAINS_TOKEN","NOT_CONTAINS_TOKEN"];

async function hsFetch(path, opts) {
  opts = opts || {};
  const r = await fetch(HS + path, Object.assign({}, opts, {
    headers: Object.assign({ "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" }, opts.headers || {})
  }));
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (!r.ok) { const err = new Error("HubSpot " + r.status + ": " + text.slice(0, 300)); err.status = r.status; throw err; }
  return json;
}
function toolName(t) { return (t || "").split("__").pop(); }

async function doSearch(args) {
  const objectType = args.objectType;
  let assocIds = null;
  for (const g of (args.filterGroups || [])) {
    if (g.associatedWith && g.associatedWith.length) {
      const aw = g.associatedWith[0];
      const dealId = (aw.objectIdValues || [])[0];
      const assoc = await hsFetch("/crm/v4/objects/" + aw.objectType + "/" + dealId + "/associations/" + objectType + "?limit=100");
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
  const res = await hsFetch("/crm/v3/objects/" + objectType + "/search", { method: "POST", body: JSON.stringify(body) });
  return {
    results: (res.results || []).map(r => ({ id: r.id, properties: r.properties })),
    total: res.total,
    offset: res.paging && res.paging.next ? Number(res.paging.next.after) : undefined
  };
}

async function doManage(args) {
  const out = {};
  if (args.createRequest && args.createRequest.objects) {
    const results = [];
    for (const o of args.createRequest.objects) {
      const created = await hsFetch("/crm/v3/objects/" + o.objectType, { method: "POST", body: JSON.stringify({ properties: o.properties || {} }) });
      if (o.associations) {
        for (const a of o.associations) {
          await hsFetch("/crm/v4/objects/" + o.objectType + "/" + created.id + "/associations/default/" + a.targetObjectType + "/" + a.targetObjectId, { method: "PUT", body: "[]" });
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
      await hsFetch("/crm/v3/objects/" + o.objectType + "/" + o.objectId, { method: "PATCH", body: JSON.stringify({ properties: o.properties || {} }) });
      if (o.associations) {
        for (const a of o.associations) {
          await hsFetch("/crm/v4/objects/" + o.objectType + "/" + o.objectId + "/associations/default/" + a.targetObjectType + "/" + a.targetObjectId, { method: "PUT", body: "[]" });
        }
      }
      results.push({ objectType: o.objectType, objectId: o.objectId });
    }
    out.updateResults = { results: results, summary: { updated: results.length, failed: 0 } };
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  const sess = verify(getCookie(event.headers || {}, COOKIE));
  if (!sess) return { statusCode: 401, body: JSON.stringify({ error: "No autenticado" }) };
  if (!TOKEN) return { statusCode: 500, body: JSON.stringify({ error: "Falta HUBSPOT_TOKEN en el entorno" }) };
  try {
    const { tool, args } = JSON.parse(event.body || "{}");
    const name = toolName(tool);
    let data;
    if (name === "search_crm_objects") data = await doSearch(args);
    else if (name === "manage_crm_objects") data = await doManage(args);
    else return { statusCode: 400, body: JSON.stringify({ error: "Tool no soportada: " + name }) };
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: e.status === 404 ? 404 : 500, body: JSON.stringify({ error: e.message }) };
  }
};
