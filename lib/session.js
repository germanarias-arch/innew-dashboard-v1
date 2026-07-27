// Sesión firmada (HMAC-SHA256) en cookie httpOnly. Runtime Cloudflare (Web Crypto, sin deps).
// Equivalente al viejo netlify/functions/_session.js pero con crypto.subtle (Workers) en vez de node:crypto.
export const COOKIE = "innew_session";

function b64urlFromBytes(buf) {
  const arr = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytesFromB64url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function utf8(s) { return new TextEncoder().encode(s); }
function utf8Decode(arr) { return new TextDecoder().decode(arr); }

async function hmacB64url(secret, bodyStr) {
  const key = await crypto.subtle.importKey(
    "raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, utf8(bodyStr));
  return b64urlFromBytes(sig);
}

export async function sign(payload, secret) {
  const body = b64urlFromBytes(utf8(JSON.stringify(payload)));
  const sig = await hmacB64url(secret, body);
  return body + "." + sig;
}

export async function verify(token, secret) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmacB64url(secret, body);
  if (expected !== sig) return null;
  try {
    const p = JSON.parse(utf8Decode(bytesFromB64url(body)));
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

// En Cloudflare recibimos el objeto Request; leemos la cookie desde sus headers.
export function getCookie(request, name) {
  const c = (request && request.headers && (request.headers.get("Cookie") || request.headers.get("cookie"))) || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
