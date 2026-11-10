import { bindings, defineConfig, triggers } from 'cf/config';
import * as entrypoint from './src/index.js' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => ({
  worker: {
    name: 'gai-routuer',
    entrypoint,
    compatibilityDate: '2026-11-10',
    compatibilityFlags: ['nodejs_compat'],
    workersDev: true,
    previewUrls: false,
    triggers: [triggers.scheduled({ schedule: '0 * * * *' })],
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true },
      traces: { enabled: true, headSamplingRate: 0.01 }
    },
    env: {
      DB: bindings.d1({ name: 'gai-routuer', id: process.env.ROUTER_D1_ID }),
      PANEL_ORIGIN: bindings.text(mode === 'development'
        ? 'http://localhost:8080' : process.env.ROUTER_PANEL_ORIGIN || ''),
      AUTH_LIMITER: bindings.rateLimit({
        namespace: '97113902', simple: { limit: 20, period: 60 }
      }),
      PASSWORD_LIMITER: bindings.rateLimit({
        namespace: '97113903', simple: { limit: 5, period: 60 }
      }),
      ADMIN_ENROLLMENT: bindings.secret(),
      PASSWORD_PEPPER: bindings.secret(),
      KEY_ENCRYPTION_KEY: bindings.secret()
    }
  }
}));
