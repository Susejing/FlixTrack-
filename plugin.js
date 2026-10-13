// FlixTrack 0.1.0 — Sincroniza películas y series con Trakt y SIMKL.
// Capability "tracking": Kino avisa cuando terminas de ver algo y este
// plugin lo registra en tu historial de Trakt y SIMKL, sin importar
// desde qué fuente lo reproduzcas.
//
// Autenticación por flujo de dispositivo (RFC 8628, el de las TVs): el
// botón "Conectar" de Ajustes muestra un código corto que apruebas desde
// el teléfono o cualquier navegador, y el plugin canjea los tokens solo.
// No hay client_secrets, ni códigos de 500 caracteres, ni expiraciones
// de minutos: Trakt entrega tokens de 7 días con renovación de 3 meses,
// y SIMKL tokens de 5 años.

const VERSION = "0.1.0";
const UA = "FlixTrack/" + VERSION;

// ---------- helpers ----------

// Igual que en AniTrack: cuando el servidor rechaza, su respuesta viaja
// en el mensaje de error (MAL nos enseñó que el cuerpo dice la verdad).
async function fetchJson(url, options) {
  const r = await kino.fetch(url, options);
  if (!r.ok) {
    let detalle = "http " + r.status;
    try {
      const cuerpo = await r.text();
      if (cuerpo) detalle = detalle + " " + String(cuerpo).slice(0, 300);
    } catch (e2) { /* sin cuerpo legible */ }
    const e = new Error(detalle);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// Evita entregar dos veces el mismo evento (Kino reintenta; el id es la clave).
function yaEntregado(id) {
  try {
    let seen = kino.storage.get("seen");
    if (!Array.isArray(seen)) seen = [];
    if (seen.indexOf(id) >= 0) return true;
    seen.push(id);
    while (seen.length > 50) seen.shift();
    kino.storage.set("seen", seen, 2500000000);
  } catch (e) {
    kino.log("storage falló:", String(e));
    return false;
  }
  return false;
}

// El último resultado de cada servicio, para la línea de Conexión.
function guardarEstado(servicio, texto) {
  try { kino.storage.set(servicio + "Estado", texto, 2500000000); } catch (e) { /* cache */ }
}

// ---------- Trakt ----------

// Toda llamada a Trakt lleva versión y la llave de tu app (el client_id).
function headersTrakt(token) {
  const h = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": String(kino.config.get("traktClientId") || "").trim()
  };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

// El access token de Trakt vence en 7 días: con el refresh token se
// renueva solo. El flujo de dispositivo no usa client_secret.
async function tokenTrakt() {
  await null;
  const guardado = kino.storage.get("traktAccessToken");
  if (guardado) return guardado;
  const refreshToken = kino.storage.get("traktRefreshToken");
  if (!refreshToken) {
    const e = new Error("sin conectar");
    e.status = "sin-conectar";
    throw e;
  }
  const r = await fetchJson("https://api.trakt.tv/oauth/token", {
    method: "POST",
    headers: headersTrakt(),
    body: { json: {
      refresh_token: refreshToken,
      client_id: String(kino.config.get("traktClientId") || "").trim(),
      grant_type: "refresh_token",
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob"
    } }
  });
  if (!r.access_token) throw new Error("Trakt no devolvió token");
  try {
    if (r.refresh_token) kino.storage.set("traktRefreshToken", r.refresh_token, 2500000000);
    kino.storage.set("traktAccessToken", r.access_token,
      Math.min(Math.max(Math.floor((r.expires_in || 604800) * 1000 / 2), 3600000), 2500000000));
  } catch (e2) { /* cache llena */ }
  return r.access_token;
}

// El botón "Conectar Trakt" de Ajustes. Un toque entrega el código para
// autorizar desde el teléfono; el siguiente toque canjea los tokens.
// Con la cuenta ya conectada, comprueba la conexión con tu usuario real.
async function conectarTrakt() {
  await null;
  const clientId = String(kino.config.get("traktClientId") || "").trim();
  if (!clientId) {
    return { message: "Falta el Client ID de Trakt: pégalo (de trakt.tv/oauth/applications) y guarda primero." };
  }

  // Ya conectado: probar con el usuario real.
  if (kino.storage.get("traktRefreshToken")) {
    try {
      const token = await tokenTrakt();
      const r = await fetchJson("https://api.trakt.tv/users/settings", { headers: headersTrakt(token) });
      return { message: "✓ Conectado a Trakt como: " + ((r.user && r.user.name) || "tu usuario") };
    } catch (e) {
      try { kino.storage.remove("traktAccessToken"); kino.storage.remove("traktRefreshToken"); } catch (e2) { }
      return { message: "La conexión no funcionó (" + String(e.status || e.message).slice(0, 70) + "). Toca de nuevo para empezar de cero." };
    }
  }

  // Flujo en curso: preguntar si ya aprobaste.
  const pendiente = kino.storage.get("traktDevice");
  if (pendiente && pendiente.code) {
    try {
      const r = await fetchJson("https://api.trakt.tv/oauth/device/token", {
        method: "POST",
        headers: headersTrakt(),
        body: { json: { code: pendiente.code, client_id: clientId } }
      });
      if (r.access_token) {
        try {
          if (r.refresh_token) kino.storage.set("traktRefreshToken", r.refresh_token, 2500000000);
          kino.storage.set("traktAccessToken", r.access_token,
            Math.min(Math.max(Math.floor((r.expires_in || 604800) * 1000 / 2), 3600000), 2500000000));
          kino.storage.remove("traktDevice");
        } catch (e2) { /* cache */ }
        guardarEstado("trakt", "ok");
        return { message: "✓ Conectado a Trakt. Tu historial se sincroniza solo con cada película o episodio terminado." };
      }
    } catch (e) {
      if (e.status === 400) {
        return { message: "Aún pendiente: entra al link, escribe el código y autoriza en Trakt. Después vuelve a tocar este botón." };
      }
      try { kino.storage.remove("traktDevice"); } catch (e2) { }
    }
  }

  // Empezar el flujo: pedir el código de dispositivo.
  try {
    const d = await fetchJson("https://api.trakt.tv/oauth/device/code", {
      method: "POST",
      headers: headersTrakt(),
      body: { json: { client_id: clientId } }
    });
    if (!d.device_code) return { message: "Trakt no entregó código: revisa el Client ID." };
    try { kino.storage.set("traktDevice", { code: d.device_code }, (d.expires_in || 600) * 1000); } catch (e2) { }
    return { message: "1) Entra a " + (d.verification_url || "https://trakt.tv/activate") +
      "   2) Escribe el código: " + (d.user_code || "?") +
      "   3) Autoriza y vuelve a tocar este botón." };
  } catch (e) {
    return { message: "Trakt rechazó el Client ID: " + String(e.status || e.message).slice(0, 100) };
  }
}

// Historial de Trakt. Un rechazo 401 renueva el token y reintenta una vez.
async function enTrakt(payload) {
  await null;
  const enviar = async (token) => kino.fetch("https://api.trakt.tv/sync/history", {
    method: "POST",
    headers: headersTrakt(token),
    body: { json: payload }
  });
  let r = await enviar(await tokenTrakt());
  if (r.status === 401) {
    kino.storage.remove("traktAccessToken");
    r = await enviar(await tokenTrakt());
  }
  if (!r.ok) {
    let detalle = "";
    try { detalle = (r.text() || "").slice(0, 80); } catch (e2) { /* sin cuerpo */ }
    const e = new Error("Trakt respondió " + r.status + " " + detalle);
    e.status = "lista " + r.status + " " + detalle.slice(0, 40);
    throw e;
  }
}

// ---------- SIMKL ----------

// SIMKL pide tres parámetros en la URL de cada llamada más el User-Agent.
function paramsSimkl() {
  return "client_id=" + encodeURIComponent(String(kino.config.get("simklClientId") || "").trim()) +
    "&app-name=flixtrack&app-version=" + VERSION;
}

// Los tokens de SIMKL (V2) duran años; si uno vence, el refresh lo renueva.
async function tokenSimkl() {
  await null;
  const guardado = kino.storage.get("simklAccessToken");
  if (guardado) return guardado;
  const refreshToken = kino.storage.get("simklRefreshToken");
  if (!refreshToken) {
    const e = new Error("sin conectar");
    e.status = "sin-conectar";
    throw e;
  }
  const r = await fetchJson("https://api.simkl.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: { form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: String(kino.config.get("simklClientId") || "").trim()
    } }
  });
  if (!r.access_token) throw new Error("SIMKL no devolvió token");
  try {
    if (r.refresh_token) kino.storage.set("simklRefreshToken", r.refresh_token, 2500000000);
    kino.storage.set("simklAccessToken", r.access_token,
      Math.min(Math.max(Math.floor((r.expires_in || 157680000) * 1000 / 2), 3600000), 2500000000));
  } catch (e2) { /* cache llena */ }
  return r.access_token;
}

// El botón "Conectar SIMKL": mismo flujo de dispositivo, con el alcance de
// escritura (media:write) que exige la documentación para marcar vistos.
async function conectarSimkl() {
  await null;
  const clientId = String(kino.config.get("simklClientId") || "").trim();
  if (!clientId) {
    return { message: "Falta el Client ID de SIMKL: crea una app (tipo TV/dispositivos) en simkl.com/settings/developer y pégala." };
  }

  if (kino.storage.get("simklRefreshToken")) {
    try {
      const token = await tokenSimkl();
      const r = await fetchJson("https://api.simkl.com/users/settings?" + paramsSimkl(), {
        headers: { Authorization: "Bearer " + token, "User-Agent": UA }
      });
      const nombre = (r.user && (r.user.name || r.user.account)) || "tu usuario";
      return { message: "✓ Conectado a SIMKL como: " + nombre };
    } catch (e) {
      try { kino.storage.remove("simklAccessToken"); kino.storage.remove("simklRefreshToken"); } catch (e2) { }
      return { message: "La conexión no funcionó (" + String(e.status || e.message).slice(0, 70) + "). Toca de nuevo para empezar de cero." };
    }
  }

  const pendiente = kino.storage.get("simklDevice");
  if (pendiente && pendiente.code) {
    try {
      const r = await fetchJson("https://api.simkl.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: { form: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pendiente.code,
          client_id: clientId
        } }
      });
      if (r.access_token) {
        try {
          if (r.refresh_token) kino.storage.set("simklRefreshToken", r.refresh_token, 2500000000);
          kino.storage.set("simklAccessToken", r.access_token,
            Math.min(Math.max(Math.floor((r.expires_in || 157680000) * 1000 / 2), 3600000), 2500000000));
          kino.storage.remove("simklDevice");
        } catch (e2) { /* cache */ }
        guardarEstado("simkl", "ok");
        return { message: "✓ Conectado a SIMKL. Tu historial se sincroniza solo con cada película o episodio terminado." };
      }
    } catch (e) {
      const texto = String(e.message || "");
      if (e.status === 400 || e.status === 428) {
        return { message: "Aún pendiente: abre el link de SIMKL, confirma el código y autoriza. Después vuelve a tocar este botón." };
      }
      if (texto.indexOf("invalid_client") >= 0) {
        try { kino.storage.remove("simklDevice"); } catch (e2) { }
        return { message: "Ese client_id no está habilitado para OAuth 2.0: tu app de SIMKL debe ser V2 (crea una nueva en simkl.com/settings/developer)." };
      }
      try { kino.storage.remove("simklDevice"); } catch (e2) { }
    }
  }

  try {
    const d = await fetchJson("https://api.simkl.com/oauth2/device", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: { form: { client_id: clientId, scope: "media:read media:write" } }
    });
    if (!d.device_code) return { message: "SIMKL no entregó código: revisa el Client ID." };
    try { kino.storage.set("simklDevice", { code: d.device_code }, (d.expires_in || 900) * 1000); } catch (e2) { }
    const url = d.verification_uri_complete || (d.verification_uri || "https://simkl.com/pin");
    return { message: "1) Abre " + url +
      "   2) Confirma el código: " + (d.user_code || "?") +
      "   3) Autoriza y vuelve a tocar este botón." };
  } catch (e) {
    return { message: "SIMKL rechazó la solicitud: " + String(e.status || e.message).slice(0, 120) };
  }
}

// Historial de SIMKL (V2): misma forma de payload que Trakt.
async function enSimkl(payload) {
  await null;
  const enviar = async (token) => kino.fetch("https://api.simkl.com/sync/history?" + paramsSimkl(), {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": UA },
    body: { json: payload }
  });
  let r = await enviar(await tokenSimkl());
  if (r.status === 401) {
    kino.storage.remove("simklAccessToken");
    r = await enviar(await tokenSimkl());
  }
  if (!r.ok) {
    let detalle = "";
    try { detalle = (r.text() || "").slice(0, 80); } catch (e2) { /* sin cuerpo */ }
    const e = new Error("SIMKL respondió " + r.status + " " + detalle);
    e.status = "lista " + r.status + " " + detalle.slice(0, 40);
    throw e;
  }
}

// ---------- track (la capability "tracking") ----------

// El evento de Kino → el payload que Trakt y SIMKL aceptan con la misma
// forma: película → movies[]; episodio → shows[] con temporada y número.
// Solo se usan los ids que Kino ya trae (imdb/tmdb/tvdb de TMDB); si no
// hay ninguno reconocible, el evento se omite sin error.
function payloadHistorial(event) {
  const limpio = (ids) => {
    const o = {};
    if (ids.imdb) o.imdb = String(ids.imdb);
    if (ids.tmdb) o.tmdb = Number(ids.tmdb);
    if (ids.tvdb) o.tvdb = Number(ids.tvdb);
    return o;
  };
  if (event.kind === "movie") {
    const ids = limpio(event.ids || {});
    if (!ids.imdb && !ids.tmdb && !ids.tvdb) return null;
    return { movies: [{ ids: ids }] };
  }
  const showIds = limpio((event.show && event.show.ids) || {});
  if (!showIds.imdb && !showIds.tmdb && !showIds.tvdb) return null;
  if (!event.season || !event.episode) return null;
  return { shows: [{
    ids: showIds,
    seasons: [{ number: Number(event.season), episodes: [{ number: Number(event.episode) }] }]
  }] };
}

// Solo se actúa en "watched": el episodio o película terminado (se dispara
// una sola vez, con 3 minutos o menos y al menos 90% visto). Cada servicio
// va aislado en su propio try: si uno falla, el otro sigue, y la línea de
// Conexión de Ajustes dice siempre el último resultado de cada uno.
export async function track(event) {
  await null;
  if (event.type !== "watched") return { ok: true };
  if (yaEntregado(event.id)) return { ok: true };

  const payload = payloadHistorial(event);
  if (!payload) {
    kino.log("sin ids de imdb/tmdb/tvdb, omitido:", event.title || "");
    return { ok: true };
  }

  if (String(kino.config.get("traktClientId") || "").trim() && kino.storage.get("traktRefreshToken")) {
    try {
      await enTrakt(payload);
      guardarEstado("trakt", "ok");
      kino.log("trakt: historial actualizado ✓");
    } catch (e) {
      const porque = String(e.status || e.code || e.message).slice(0, 60);
      guardarEstado("trakt", "error " + porque);
      kino.log("trakt falló:", porque);
    }
  }

  if (String(kino.config.get("simklClientId") || "").trim() && kino.storage.get("simklRefreshToken")) {
    try {
      await enSimkl(payload);
      guardarEstado("simkl", "ok");
      kino.log("simkl: historial actualizado ✓");
    } catch (e) {
      const porque = String(e.status || e.code || e.message).slice(0, 60);
      guardarEstado("simkl", "error " + porque);
      kino.log("simkl falló:", porque);
    }
  }

  return { ok: true };
}

// La línea "Conexión" de Ajustes: estado de cada servicio y, si falló el
// último envío, el motivo exacto.
export async function settingsStatus() {
  await null;
  let trakt = "Trakt —";
  if (String(kino.config.get("traktClientId") || "").trim()) {
    const estado = kino.storage.get("traktEstado");
    if (estado && estado.indexOf("error") === 0) trakt = "Trakt ⚠ " + estado.slice(6, 45);
    else if (kino.storage.get("traktRefreshToken")) trakt = "Trakt ✓";
    else trakt = "Trakt · toca Conectar";
  }
  let simkl = "SIMKL —";
  if (String(kino.config.get("simklClientId") || "").trim()) {
    const estado = kino.storage.get("simklEstado");
    if (estado && estado.indexOf("error") === 0) simkl = "SIMKL ⚠ " + estado.slice(6, 45);
    else if (kino.storage.get("simklRefreshToken")) simkl = "SIMKL ✓";
    else simkl = "SIMKL · toca Conectar";
  }
  return { estado: trakt + "  ·  " + simkl };
}

// Los botones de Ajustes: conectar (o probar) cada cuenta.
export async function action(key) {
  await null;
  if (key === "conectarTrakt") return conectarTrakt();
  if (key === "conectarSimkl") return conectarSimkl();
  return null;
}
