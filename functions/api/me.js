// GET /api/me — Devuelve identidad y rol del usuario logueado (lee la cookie firmada).
// Cloudflare Pages Function (reemplaza netlify/functions/me.js).
import { verify, getCookie, COOKIE } from "../../lib/session.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const SECRET = env.SESSION_SECRET || "cambia-esto-en-cloudflare";
  const sess = await verify(getCookie(request, COOKIE), SECRET);
  if (!sess) {
    return new Response(JSON.stringify({ error: "No autenticado" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }
  return new Response(JSON.stringify({
    email: sess.email, name: sess.name, role: sess.role || "full",
    ownerId: sess.ownerId || "", csmName: sess.csmName || ""
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
