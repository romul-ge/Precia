/*
 * Shared server client. Every page that needs data includes this file:
 *   <script src="api.js"></script>
 * It keeps sign-in, tokens, retries and error handling in one place.
 *
 * Put this file in the same folder as the html pages.
 */
(function () {
  'use strict';

  /* ═════════════ Settings ═════════════ */

  // Where the backend lives. The right one is picked automatically:
  //   - page opened from a file on your computer, or from localhost  ->  the backend on this computer
  //   - page published on the internet (GitHub Pages, Telegram)       ->  PUBLIC_API
  const LOCAL_API = 'http://localhost:3000';

  // CHANGE THIS before publishing: the public https address of your backend,
  // for example your ngrok address 'https://your-name.ngrok-free.app' or 'https://api.example.com'.
  const PUBLIC_API = 'https://YOUR-NAME.ngrok-free.app';

  const onThisComputer = window.location.protocol === 'file:'
    || window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1';
  const API_BASE = onThisComputer ? LOCAL_API : PUBLIC_API;

  if (API_BASE.indexOf('YOUR-NAME') !== -1) {
    console.error('api.js: set PUBLIC_API to the public address of your backend.');
  }

  // Free ngrok tunnels show a warning page to browsers; this header tells ngrok to skip it for our requests.
  const EXTRA_HEADERS = /ngrok/i.test(API_BASE) ? { 'ngrok-skip-browser-warning': '1' } : {};

  const PREFIX = '/api/v1';
  const SESSION_KEY = 'recipeapp.session.v1';
  const DEV_USER_KEY = 'local';   // test user, used only outside Telegram and only if the server allows dev sign-in

  const tg = window.Telegram && window.Telegram.WebApp;

  /* ═════════════ Errors ═════════════ */

  // The server answered with an error. `body` is what it sent: { error: "message", code: "..." }.
  class ApiError extends Error {
    constructor(status, body, fallbackMessage) {
      super((body && typeof body.error === 'string' && body.error) || fallbackMessage);
      this.name = 'ApiError';
      this.status = status;
      this.body = body || null;
      this.code = (body && body.code) || 'error';
    }
  }

  // The server could not be reached at all (offline, server stopped, blocked by the browser).
  class NetworkError extends Error {
    constructor() {
      super('Network error');
      this.name = 'NetworkError';
    }
  }

  const abortError = () => new DOMException('Aborted', 'AbortError');

  /* ═════════════ Session (tokens) ═════════════ */

  function readSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  let session = readSession();   // { accessToken, refreshToken, expiresAt }

  function writeSession(next) {
    session = next;
    try {
      if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) { /* storage blocked: the session just lives in memory */ }
  }

  const fromTokens = t => ({
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: Date.now() + t.expiresIn * 1000
  });

  /* ═════════════ Low-level request ═════════════ */

  async function send(path, { method = 'GET', json, token, signal } = {}) {
    const headers = { ...EXTRA_HEADERS };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(API_BASE + PREFIX + path, {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : undefined,
        signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new NetworkError();
    }

    if (res.status === 204) return null;
    let body = null;
    try { body = await res.json(); } catch (_) { /* empty or not JSON */ }
    if (!res.ok) throw new ApiError(res.status, body, 'Request failed (' + res.status + ')');
    return body;
  }

  /* ═════════════ Signing in ═════════════ */

  // Several requests may need a token at the same moment (a page loads two lists at once).
  // Only one sign-in or refresh runs; the others wait for its result.
  let pending = null;
  function once(fn) {
    if (!pending) pending = fn().finally(() => { pending = null; });
    return pending;
  }

  async function login() {
    if (tg && tg.initData) {
      // Inside Telegram: prove who the user is with the data Telegram signed
      return fromTokens(await send('/auth/telegram', { method: 'POST', json: { initData: tg.initData } }));
    }
    try {
      // In a normal browser (testing): the server's development sign-in
      return fromTokens(await send('/auth/dev', { method: 'POST', json: { userKey: DEV_USER_KEY } }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new ApiError(401, { error: 'Open this app from Telegram to sign in.', code: 'no_dev_auth' }, 'Sign-in failed');
      }
      throw err;
    }
  }

  async function refresh() {
    if (!session || !session.refreshToken) return null;
    try {
      return fromTokens(await send('/auth/refresh', { method: 'POST', json: { refreshToken: session.refreshToken } }));
    } catch (err) {
      if (err instanceof ApiError) return null;   // the server refused it: sign in again
      throw err;                                  // no connection: not the same thing as a bad session
    }
  }

  // Gives a usable access token: the stored one while it is fresh, otherwise a refreshed or new one.
  function ensureToken({ force = false } = {}) {
    return once(async () => {
      if (!force && session && session.expiresAt - Date.now() > 30000) return session.accessToken;
      let next = await refresh();
      if (!next) next = await login();
      writeSession(next);
      return next.accessToken;
    });
  }

  // A normal request with the token attached. If the server says the token is no good, get a new one and try once more.
  async function request(path, opts = {}) {
    let token = await ensureToken();
    try {
      return await send(path, { ...opts, token });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      token = await ensureToken({ force: true });
      return send(path, { ...opts, token });
    }
  }

  /* ═════════════ Photo upload (with progress) ═════════════ */

  // XMLHttpRequest instead of fetch: fetch cannot report upload progress.
  function xhrUpload(path, blob, filename, token, hooks) {
    const { onProgress, onSent, signal } = hooks;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortError()); return; }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API_BASE + PREFIX + path);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      Object.keys(EXTRA_HEADERS).forEach(k => xhr.setRequestHeader(k, EXTRA_HEADERS[k]));
      xhr.responseType = 'json';
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.upload.onload = () => { if (onSent) onSent(); };   // all bytes sent, the server is now checking the file
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
        ? resolve(xhr.response)
        : reject(new ApiError(xhr.status, xhr.response, 'Upload failed (' + xhr.status + ')'));
      xhr.onerror = () => reject(new NetworkError());
      xhr.onabort = () => reject(abortError());
      if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });

      const form = new FormData();
      form.append('photo', blob, filename);
      xhr.send(form);
    });
  }

  async function uploadPhoto(blob, hooks) {
    hooks = hooks || {};
    const filename = blob.type === 'image/webp' ? 'photo.webp' : 'photo.jpg';
    let token = await ensureToken();
    try {
      return await xhrUpload('/uploads/recipe-photo', blob, filename, token, hooks);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      token = await ensureToken({ force: true });
      return xhrUpload('/uploads/recipe-photo', blob, filename, token, hooks);
    }
  }

  /* ═════════════ What the pages can call ═════════════ */

  const enc = encodeURIComponent;

  window.Api = {
    base: API_BASE,
    ApiError,
    NetworkError,

    ready: () => ensureToken().then(() => undefined),
    me: () => request('/me'),
    async logout() {
      const refreshToken = session && session.refreshToken;
      writeSession(null);
      if (refreshToken) { try { await send('/auth/logout', { method: 'POST', json: { refreshToken } }); } catch (_) {} }
    },

    // recipes
    listRecipes: () => request('/recipes'),
    getRecipe: id => request('/recipes/' + enc(id)),
    createRecipe: payload => request('/recipes', { method: 'POST', json: payload }),
    setFavorite: (id, fav) => request('/recipes/' + enc(id) + '/favorite', { method: 'PUT', json: { fav } }),
    deleteRecipe: id => request('/recipes/' + enc(id), { method: 'DELETE' }),

    // ingredients
    listIngredients: () => request('/ingredients'),
    createIngredient: payload => request('/ingredients', { method: 'POST', json: payload }),
    updateIngredient: (id, payload) => request('/ingredients/' + enc(id), { method: 'PUT', json: payload }),
    deleteIngredient: id => request('/ingredients/' + enc(id), { method: 'DELETE' }),

    // photos
    uploadPhoto,
    deleteUpload: id => request('/uploads/' + enc(id), { method: 'DELETE' })
  };
})();
