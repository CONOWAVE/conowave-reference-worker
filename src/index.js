/**
 * conowave-reference-worker
 *
 * Baut den Umkehrindex Projekt zu Produkt fuer den Artikelfuss auf
 * conowave.com. Ausloeser: Cron zweimal taeglich und die Shopify-Webhooks
 * metaobjects/create und metaobjects/update, gefiltert auf type:projekt.
 *
 * Endpunkte:
 *   POST /webhook/metaobject   Shopify-Webhook, HMAC-geprueft, gedrosselt
 *   POST /run                  manueller Anstoss, Bearer ADMIN_TOKEN
 *   GET  /health               Zeitpunkt und Ergebnis des letzten Laufs
 */

import { lauf, letzterLauf } from './run.js';

const DROSSEL_MS = 120_000;
const KV_DROSSEL = 'drossel:bis';
const KV_NACHHOLEN = 'drossel:nachholen';

function json(wert, status = 200) {
  return new Response(JSON.stringify(wert, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Zeitkonstanter Vergleich, damit die Signaturpruefung nichts verraet. */
function gleich(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacGueltig(env, rohkoerper, signatur) {
  if (!signatur) return false;
  const schluessel = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SHOPIFY_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', schluessel, new TextEncoder().encode(rohkoerper));
  const erwartet = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return gleich(erwartet, signatur);
}

/**
 * Drosselung statt Entprellung: ein Massenimport loest sonst 223 Laeufe aus.
 * Wird ein Ereignis innerhalb des Fensters abgewiesen, merkt sich der Worker
 * das in nachholen und laeuft gleich nach dem naechsten Lauf noch einmal.
 */
async function angestossen(env, anlass) {
  const bis = Number((await env.REF_CACHE.get(KV_DROSSEL)) || 0);
  if (Date.now() < bis) {
    await env.REF_CACHE.put(KV_NACHHOLEN, '1', { expirationTtl: 3600 });
    return { gedrosselt: true, naechster_lauf_ab: new Date(bis).toISOString() };
  }

  await env.REF_CACHE.put(KV_DROSSEL, String(Date.now() + DROSSEL_MS), { expirationTtl: 600 });
  const ergebnis = await lauf(env, anlass);

  if (await env.REF_CACHE.get(KV_NACHHOLEN)) {
    await env.REF_CACHE.delete(KV_NACHHOLEN);
    const nachgeholt = await lauf(env, `${anlass}+nachholen`);
    return { ergebnis, nachgeholt };
  }

  return { ergebnis };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      const letzter = await letzterLauf(env);
      return json({
        dienst: 'conowave-reference-worker',
        shop: env.SHOPIFY_SHOP,
        letzter_lauf: letzter || null,
      });
    }

    /* Ein Endpunkt fuer alle Themen. Die Nutzlast wird ohnehin nicht gelesen,
       also ist es gleich, ob metaobjects/* oder articles/* ihn ausloest.
       /webhook/metaobject bleibt als Zweitname bestehen. */
    if (
      request.method === 'POST' &&
      (url.pathname === '/webhook/shopify' || url.pathname === '/webhook/metaobject')
    ) {
      const roh = await request.text();
      const signatur = request.headers.get('X-Shopify-Hmac-Sha256');

      if (!(await hmacGueltig(env, roh, signatur))) {
        return json({ fehler: 'Signatur ungueltig' }, 401);
      }

      /* Die Nutzlast ist ein Signal, keine Datenquelle. Ihr Inhalt wird nicht
         verarbeitet, der Lauf liest ohnehin alles neu. */
      ctx.waitUntil(angestossen(env, 'webhook'));
      return json({ angenommen: true });
    }

    if (request.method === 'POST' && url.pathname === '/run') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ fehler: 'nicht berechtigt' }, 401);
      }

      const erzwingen = url.searchParams.get('force') === '1';
      if (erzwingen) {
        return json(await lauf(env, 'manuell-erzwungen'));
      }
      return json(await angestossen(env, 'manuell'));
    }

    return json({ fehler: 'nicht gefunden' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(lauf(env, 'cron'));
  },
};
