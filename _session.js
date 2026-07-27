// Sesión firmada (HMAC) en cookie httpOnly. Sin dependencias externas.
const crypto = require("crypto");
const SECRET = process.env.SESSION_SECRET || "cambia-esto-en-netlify";
const COOKIE = "innew_session";

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verify(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (expected !== sig) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
function getCookie(headers, name) {
  const c = (headers && (headers.cookie || headers.Cookie)) || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
module.exports = { sign, verify, getCookie, COOKIE };
