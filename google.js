// Verifica el ID token de Google sin dependencias node (reemplaza google-auth-library).
// Usa el endpoint oficial tokeninfo, que valida firma + expiración del lado de Google
// y devuelve los claims. Suficiente para un dashboard interno de bajo volumen.
export async function verifyGoogleIdToken(credential, clientId) {
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  if (!r.ok) throw new Error("Token no verificable");
  const p = await r.json();
  if (!p || p.error) throw new Error(p && p.error_description ? p.error_description : "Token inválido");
  if (p.aud !== clientId) throw new Error("Audiencia inválida");
  // exp viene como string de epoch seconds
  if (p.exp && Date.now() > Number(p.exp) * 1000) throw new Error("Token expirado");
  return p; // { email, email_verified, hd, name, aud, exp, ... }
}
