// Devuelve la identidad y el rol del usuario logueado (lee la cookie de sesión firmada).
const { verify, getCookie, COOKIE } = require("./_session");

exports.handler = async (event) => {
  const sess = verify(getCookie(event.headers || {}, COOKIE));
  if (!sess) return { statusCode: 401, body: JSON.stringify({ error: "No autenticado" }) };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: sess.email, name: sess.name, role: sess.role || "full", ownerId: sess.ownerId || "", csmName: sess.csmName || "" })
  };
};
