// POST /api/auth — Verifica el ID token de Google y setea la cookie de sesión firmada.
// Cloudflare Pages Function (reemplaza netlify/functions/auth.js).
import { sign, COOKIE } from "../../lib/session.js";
import { verifyGoogleIdToken } from "../../lib/google.js";

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {})
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ALLOWED_DOMAIN = env.ALLOWED_DOMAIN || "innew.la";
  // Lista blanca opcional: si está seteada, SOLO estos mails entran (aunque sean @innew.la).
  const ALLOWED_EMAILS = (env.ALLOWED_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const CLIENT_ID = env.GOOGLE_CLIENT_ID;
  const SECRET = env.SESSION_SECRET || "cambia-esto-en-cloudflare";

  // Resellers: "email:hubspotOwnerId,email:ownerId" → entran SOLO al Panel Reseller.
  const RESELLER_MAP = {};
  (env.RESELLER_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean).forEach(pair => {
    const idx = pair.indexOf(":");
    const em = (idx >= 0 ? pair.slice(0, idx) : pair).trim().toLowerCase();
    const oid = idx >= 0 ? pair.slice(idx + 1).trim() : "";
    if (em) RESELLER_MAP[em] = oid;
  });
  // CSMs: "email:Nombre CSM" → entran SOLO a su cartera de Cuentas activas.
  const CSM_MAP = {};
  (env.CSM_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean).forEach(pair => {
    const idx = pair.indexOf(":");
    const em = (idx >= 0 ? pair.slice(0, idx) : pair).trim().toLowerCase();
    const nm = idx >= 0 ? pair.slice(idx + 1).trim() : "";
    if (em) CSM_MAP[em] = nm;
  });

  try {
    const body = await request.json().catch(() => ({}));
    const credential = body && body.credential;
    if (!credential) return json({ error: "Falta credential" }, 400);

    const p = await verifyGoogleIdToken(credential, CLIENT_ID);
    const email = (p.email || "").toLowerCase();
    const domain = p.hd || email.split("@")[1];
    const emailVerified = p.email_verified === true || p.email_verified === "true";
    if (!emailVerified || domain !== ALLOWED_DOMAIN) {
      return json({ error: "Acceso solo para cuentas @" + ALLOWED_DOMAIN }, 403);
    }
    if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) {
      return json({ error: "Tu cuenta no está habilitada para este dashboard. Pedí acceso a German." }, 403);
    }
    const isReseller = Object.prototype.hasOwnProperty.call(RESELLER_MAP, email);
    const isCsm = !isReseller && Object.prototype.hasOwnProperty.call(CSM_MAP, email);
    const role = isReseller ? "reseller" : (isCsm ? "csm" : "full");
    const ownerId = isReseller ? (RESELLER_MAP[email] || "") : "";
    const csmName = isCsm ? (CSM_MAP[email] || "") : "";
    const token = await sign({ email, name: p.name, role, ownerId, csmName, exp: Date.now() + 12 * 3600 * 1000 }, SECRET);
    const cookie = COOKIE + "=" + encodeURIComponent(token) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200";
    return json({ ok: true, email, name: p.name, role }, 200, { "Set-Cookie": cookie });
  } catch (e) {
    return json({ error: "Token inválido: " + e.message }, 401);
  }
}
