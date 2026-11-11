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
import { graphql, tokenVerwerfen } from './shopify.js';

/**
 * Diagnose. Fragt mehrere kleine Dinge einzeln ab und meldet je Punkt
 * entweder das Ergebnis oder den Fehler. Damit laesst sich klaeren, mit
 * welchem Shop der Worker spricht und welche Rechte das Token wirklich hat.
 */
async function diagnose(env) {
  const teile = {
    shop_laut_konfiguration: env.SHOPIFY_SHOP,
    api_version: env.SHOPIFY_API_VERSION,
  };

  const fragen = {
    shop: `{ shop { name myshopifyDomain } }`,
    rechte: `{ currentAppInstallation { accessScopes { handle } } }`,
    definitionen: `{ metaobjectDefinitions(first: 50) { nodes { type name } } }`,
    referenzpool: `{ metaobjects(type: "referenzpool", first: 5) { nodes { handle fields { key type } } } }`,
    projekt: `{ metaobjects(type: "projekt", first: 2) { nodes { handle fields { key } } } }`,
  };

  for (const [name, frage] of Object.entries(fragen)) {
    try {
      teile[name] = await graphql(env, frage);
    } catch (e) {
      teile[name] = { fehler: e.message };
    }
  }

  return teile;
}

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

    if (request.method === 'POST' && url.pathname === '/diag') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ fehler: 'nicht berechtigt' }, 401);
      }
      if (url.searchParams.get('token') === 'neu') await tokenVerwerfen(env);
      return json(await diagnose(env));
    }

    if (request.method === 'POST' && url.pathname === '/run') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ fehler: 'nicht berechtigt' }, 401);
      }

      /* Fehler hier als JSON zurueckgeben statt als Worker-Ausnahme.
         Sonst sieht der Aufrufer nur "error code: 1101". */
      try {
        if (url.searchParams.get('token') === 'neu') await tokenVerwerfen(env);
        const erzwingen = url.searchParams.get('force') === '1';
        if (erzwingen) {
          return json(await lauf(env, 'manuell-erzwungen'));
        }
        return json(await angestossen(env, 'manuell'));
      } catch (e) {
        console.error(`Lauf abgebrochen: ${e.message}`);
        return json({ fehler: e.message, stack: e.stack }, 500);
      }
    }

    return json({ fehler: 'nicht gefunden' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(lauf(env, 'cron'));
  },
};
