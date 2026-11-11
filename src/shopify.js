/**
 * Zugang zur Shopify Admin API.
 *
 * Token ueber client_credentials, 24 Stunden gueltig, in KV zwischengespeichert.
 * Dasselbe Muster wie getAccessToken() im conowave-erp-worker.
 */

export const TOKEN_KEY = 'shopify:token';

/**
 * Wirft das zwischengespeicherte Token weg. Noetig nach jeder Scope-Aenderung
 * an der App: ein bereits geholtes Token behaelt die alten Rechte, bis es
 * ablaeuft, und laeuft dann still ins Leere.
 */
export async function tokenVerwerfen(env) {
  await env.REF_CACHE.delete(TOKEN_KEY);
}

export async function getAccessToken(env) {
  const cached = await env.REF_CACHE.get(TOKEN_KEY, { type: 'json' });
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached.access_token;
  }

  const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    throw new Error(`Token fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const expires_in = data.expires_in || 86400;

  await env.REF_CACHE.put(
    TOKEN_KEY,
    JSON.stringify({
      access_token: data.access_token,
      expires_at: Date.now() + expires_in * 1000,
    }),
    { expirationTtl: Math.max(expires_in - 120, 300) },
  );

  return data.access_token;
}

/**
 * Ein GraphQL-Aufruf. Wiederholt bei 429 und 5xx, maximal drei Versuche.
 * Wirft bei userErrors nicht von selbst, das entscheidet der Aufrufer.
 */
export async function graphql(env, query, variables = {}, versuch = 1) {
  const token = await getAccessToken(env);
  const url = `https://${env.SHOPIFY_SHOP}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if ((res.status === 429 || res.status >= 500) && versuch < 3) {
    const warte = Number(res.headers.get('Retry-After') || 2) * 1000 * versuch;
    await new Promise((r) => setTimeout(r, warte));
    return graphql(env, query, variables, versuch + 1);
  }

  if (!res.ok) {
    throw new Error(`GraphQL ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();

  if (body.errors) {
    const gedrosselt = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
    if (gedrosselt && versuch < 3) {
      await new Promise((r) => setTimeout(r, 2000 * versuch));
      return graphql(env, query, variables, versuch + 1);
    }
    throw new Error(`GraphQL-Fehler: ${JSON.stringify(body.errors)}`);
  }

  return body.data;
}

/** Sammelt die Fehler aller userErrors-Felder einer Mutationsantwort. */
export function userErrors(ergebnis) {
  const alle = [];
  for (const wert of Object.values(ergebnis || {})) {
    if (wert && Array.isArray(wert.userErrors)) alle.push(...wert.userErrors);
  }
  return alle;
}
