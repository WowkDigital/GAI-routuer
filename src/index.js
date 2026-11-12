import { HttpError } from './common.js';
import { prune, routeAdmin } from './admin.js';
import { requireSession, routeAuth } from './auth.js';
import { updatePassword } from './password.js';
import { routeGemini } from './router.js';
import { manageConfigToken, routeConfig } from './config-api.js';

const geminiPath = /^\/(v1beta|v1)\/models\/([A-Za-z0-9_.-]{1,100}):(generateContent|streamGenerateContent|countTokens)$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const admin = url.pathname.startsWith('/admin/');
    const auth = url.pathname.startsWith('/auth/');
    const origin = request.headers.get('Origin');
    const panelRoute = admin || auth;
    const allowedOrigin = panelRoute && origin && origin === env.PANEL_ORIGIN ? origin : null;
    const finish = response => {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      if (panelRoute) headers.append('Vary', 'Origin');
      if (allowedOrigin) headers.set('Access-Control-Allow-Origin', allowedOrigin);
      return new Response(response.body, { status: response.status, headers });
    };

    try {
      if (panelRoute) {
        if ((auth || origin) && !allowedOrigin) throw new HttpError(403, 'Origin not allowed');
        if (request.method === 'OPTIONS') {
          return finish(new Response(null, { status: 204, headers: {
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '600'
          } }));
        }
        if (auth) return finish(await routeAuth(request, env, url.pathname));
        const session = await requireSession(request, env.DB);
        if (url.pathname === '/admin/config-token') {
          return finish(await manageConfigToken(request, env.DB));
        }
        if (url.pathname === '/admin/password') {
          return finish(await updatePassword(request, env, session));
        }
        return finish(await routeAdmin(request, env, url.pathname));
      }
      if (url.pathname === '/config/v1' || url.pathname.startsWith('/config/v1/')) {
        return finish(await routeConfig(request, env, url.pathname));
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        return finish(Response.json({ ok: true }));
      }
      const path = url.pathname.match(geminiPath);
      if (path) return finish(await routeGemini(request, env, ctx, path, url));
      throw new HttpError(404, 'Unknown endpoint');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('handler_failed', request.method, panelRoute ? 'panel' : 'router');
      return finish(Response.json({ error: {
        code: status, message: status === 500 ? 'Internal router error' : error.message
      } }, { status }));
    }
  },

  scheduled(_event, env, ctx) {
    const now = Date.now();
    ctx.waitUntil(Promise.all([
      prune(env.DB),
      env.DB.batch([
        env.DB.prepare('DELETE FROM admin_challenges WHERE expires_at <= ?').bind(now),
        env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now)
      ])
    ]));
  }
};
