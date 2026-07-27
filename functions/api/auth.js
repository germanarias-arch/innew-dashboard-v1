// Verifica el ID token de Google y, si el dominio es innew.la, setea la cookie de sesión.
const { OAuth2Client } = require("google-auth-library");
const { sign, COOKIE } = require("./_session");

const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "innew.la";
// Lista blanca opcional: si está seteada, SOLO estos mails entran (aunque sean @innew.la).
// Formato: "german.arias@innew.la,joaquin@innew.la". Si queda vacía, entran todos los @innew.la.
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
// Resellers: formato "email:hubspotOwnerId" separados por coma. Estos entran SOLO al Panel Reseller.
// Ej: "alfredo.torres@innew.la:361714043,alejandro.becerra@innew.la:93605053"
const RESELLER_MAP = {};
(process.env.RESELLER_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean).forEach(pair => {
  const idx = pair.indexOf(":");
  const em = (idx >= 0 ? pair.slice(0, idx) : pair).trim().toLowerCase();
  const oid = idx >= 0 ? pair.slice(idx + 1).trim() : "";
  if (em) RESELLER_MAP[em] = oid;
});
// CSMs: formato "email:Nombre CSM" separados por coma. Entran SOLO a su cartera de Cuentas activas.
// El "Nombre CSM" debe coincidir con el valor de csm_asignado en HubSpot. Ej: "jennifer@innew.la:Jennifer,celeste.lestani@innew.la:Celeste"
const CSM_MAP = {};
(process.env.CSM_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean).forEach(pair => {
  const idx = pair.indexOf(":");
  const em = (idx >= 0 ? pair.slice(0, idx) : pair).trim().toLowerCase();
  const nm = idx >= 0 ? pair.slice(idx + 1).trim() : "";
  if (em) CSM_MAP[em] = nm;
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const { credential } = JSON.parse(event.body || "{}");
    if (!credential) return { statusCode: 400, body: JSON.stringify({ error: "Falta credential" }) };
    const client = new OAuth2Client(CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: CLIENT_ID });
    const p = ticket.getPayload();
    const email = (p.email || "").toLowerCase();
    const domain = p.hd || email.split("@")[1];
    if (!p.email_verified || domain !== ALLOWED_DOMAIN) {
      return { statusCode: 403, body: JSON.stringify({ error: "Acceso solo para cuentas @" + ALLOWED_DOMAIN }) };
    }
    if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Tu cuenta no está habilitada para este dashboard. Pedí acceso a German." }) };
    }
    const isReseller = Object.prototype.hasOwnProperty.call(RESELLER_MAP, email);
    const isCsm = !isReseller && Object.prototype.hasOwnProperty.call(CSM_MAP, email);
    const role = isReseller ? "reseller" : (isCsm ? "csm" : "full");
    const ownerId = isReseller ? (RESELLER_MAP[email] || "") : "";
    const csmName = isCsm ? (CSM_MAP[email] || "") : "";
    const token = sign({ email, name: p.name, role, ownerId, csmName, exp: Date.now() + 12 * 3600 * 1000 });
    const cookie = COOKIE + "=" + encodeURIComponent(token) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200";
    return { statusCode: 200, headers: { "Set-Cookie": cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, email, name: p.name, role }) };
  } catch (e) {
    return { statusCode: 401, body: JSON.stringify({ error: "Token inválido: " + e.message }) };
  }
};
