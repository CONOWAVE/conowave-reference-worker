/**
 * Der eigentliche Lauf: dreht die Beziehung Projekt zu Produkt um und legt das
 * Ergebnis dort ab, wo Liquid es ohne Suche findet.
 *
 * Warum ueberhaupt: Am Metaobjekt projekt steht custom.products, also Projekt
 * zu Produkten. Der Artikelfuss braucht die Gegenrichtung. Liquid kann die 223
 * Projekte nicht durchsuchen, eine Schleife ueber metaobjects.projekt.values
 * bricht bei 50 Eintraegen ab. Also wird der Umkehrindex hier gebaut und
 * geschrieben.
 *
 * Zwei Ziele:
 *   Index A  Produkt.custom.referenzen        bis 6 Projekte je Produkt
 *   Index B  Metaobjekt referenzpool[branche] bis 6 Projekte je Branche
 *
 * Der Eintrag referenzpool/standard wird NICHT angefasst, der ist redaktionell.
 */

import { graphql, userErrors } from './shopify.js';

const PROJEKT_TYP = 'projekt';
const POOL_TYP = 'referenzpool';
const PRODUKT_NAMESPACE = 'custom';
const PRODUKT_KEY = 'referenzen';
const MAX_JE_ZIEL = 6;
const POOL_UNANGETASTET = ['standard'];

const KV_HASHES = 'index:hashes';
const KV_PRODUKTE = 'index:produkte';
const KV_LETZTER_LAUF = 'lauf:letzter';

/* ------------------------------------------------------------------ Abfragen */

const Q_DEFINITION = `
  query Definition($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      fieldDefinitions { key name type { name } }
    }
  }
`;

const Q_PROJEKTE = `
  query Projekte($after: String) {
    metaobjects(type: "${PROJEKT_TYP}", first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        updatedAt
        fields { key value }
      }
    }
  }
`;

const M_METAFELDER_SETZEN = `
  mutation Setzen($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

const M_METAFELDER_LOESCHEN = `
  mutation Loeschen($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

const M_POOL_SCHREIBEN = `
  mutation Pool($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message }
    }
  }
`;

/* -------------------------------------------------------------------- Helfer */

async function hash(wert) {
  const daten = new TextEncoder().encode(JSON.stringify(wert));
  const puffer = await crypto.subtle.digest('SHA-256', daten);
  return [...new Uint8Array(puffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Branchenbezeichnung zu Pool-Handle. Muss mit der Section uebereinstimmen,
 * die in Liquid rechnet: branche | downcase | strip | replace: ' ', '-'
 */
export function poolHandle(branche) {
  return String(branche || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-');
}

/** Felder eines Metaobjekts als flaches Objekt. */
function felder(node) {
  const o = {};
  for (const f of node.fields || []) o[f.key] = f.value;
  return o;
}

/** Produkt-GIDs aus einem list.product_reference Rohwert. */
function produktGids(rohwert) {
  if (!rohwert) return [];
  try {
    const w = JSON.parse(rohwert);
    return Array.isArray(w) ? w.filter((g) => typeof g === 'string' && g.startsWith('gid://')) : [];
  } catch {
    return [];
  }
}

/**
 * Feste Reihenfolge: Flagship zuerst, danach alphabetisch nach Name.
 * Nichts Zufaelliges, schon wegen des Seiten-Caches und weil Google sonst bei
 * jedem Crawl andere interne Links sieht.
 */
function sortieren(liste) {
  return [...liste].sort((a, b) => {
    if (a.flagship !== b.flagship) return a.flagship ? -1 : 1;
    return a.name.localeCompare(b.name, 'de');
  });
}

/* ---------------------------------------------------------------- Hauptlauf */

export async function lauf(env, anlass = 'manuell') {
  const start = Date.now();
  const protokoll = {
    anlass,
    begonnen: new Date(start).toISOString(),
    projekte: 0,
    produkte_im_index: 0,
    produkte_geschrieben: 0,
    produkte_geleert: 0,
    pools_geschrieben: 0,
    uebersprungen: 0,
    produkte_ohne_projekt: [],
    fehler: [],
  };

  /* 1. Feldschluessel des Pools ermitteln, statt sie zu raten. */
  const def = await graphql(env, Q_DEFINITION, { type: POOL_TYP });
  const poolFelder = def.metaobjectDefinitionByType?.fieldDefinitions || [];
  const projekteFeld = poolFelder.find((f) => f.type?.name === 'list.metaobject_reference');
  const nameFeld = poolFelder.find((f) => f.type?.name === 'single_line_text_field');

  if (!projekteFeld) {
    throw new Error(`Im Metaobjekt ${POOL_TYP} fehlt ein Feld vom Typ list.metaobject_reference`);
  }

  /* 2. Alle Projekte lesen. 223 Stueck, also eine Seite, die Schleife ist Vorsorge. */
  const projekte = [];
  let after = null;
  do {
    const data = await graphql(env, Q_PROJEKTE, { after });
    const seite = data.metaobjects;
    for (const node of seite.nodes) {
      const f = felder(node);
      projekte.push({
        gid: node.id,
        handle: node.handle,
        name: f['custom.name'] || node.handle,
        branche: f['custom.branch'] || '',
        flagship: f['custom.flagship'] === 'true',
        produkte: produktGids(f['custom.products']),
      });
    }
    after = seite.pageInfo.hasNextPage ? seite.pageInfo.endCursor : null;
  } while (after);

  protokoll.projekte = projekte.length;

  /* 3. Index A, je Produkt. */
  const jeProdukt = new Map();
  for (const p of projekte) {
    for (const produktGid of p.produkte) {
      if (!jeProdukt.has(produktGid)) jeProdukt.set(produktGid, []);
      jeProdukt.get(produktGid).push(p);
    }
  }

  /* 4. Index B, je Branche. */
  const jeBranche = new Map();
  for (const p of projekte) {
    if (!p.branche) continue;
    const handle = poolHandle(p.branche);
    if (POOL_UNANGETASTET.includes(handle)) continue;
    if (!jeBranche.has(handle)) jeBranche.set(handle, { label: p.branche, projekte: [] });
    jeBranche.get(handle).projekte.push(p);
  }

  protokoll.produkte_im_index = jeProdukt.size;

  /* 5. Sortieren und kappen. */
  const zielProdukt = new Map();
  for (const [produktGid, liste] of jeProdukt) {
    zielProdukt.set(
      produktGid,
      sortieren(liste).slice(0, MAX_JE_ZIEL).map((p) => p.gid),
    );
  }

  const zielPool = new Map();
  for (const [handle, eintrag] of jeBranche) {
    zielPool.set(handle, {
      label: eintrag.label,
      gids: sortieren(eintrag.projekte).slice(0, MAX_JE_ZIEL).map((p) => p.gid),
    });
  }

  /* 6. Nur schreiben, was sich geaendert hat.
        Ohne diesen Vergleich wandert das Aenderungsdatum aller Produkte
        zweimal taeglich, und jede Integration an products/update laeuft mit. */
  const alteHashes = (await env.REF_CACHE.get(KV_HASHES, { type: 'json' })) || {};
  const neueHashes = {};
  const zuSetzen = [];

  for (const [produktGid, gids] of zielProdukt) {
    const h = await hash(gids);
    neueHashes[`produkt:${produktGid}`] = h;
    if (alteHashes[`produkt:${produktGid}`] === h) {
      protokoll.uebersprungen += 1;
      continue;
    }
    zuSetzen.push({
      ownerId: produktGid,
      namespace: PRODUKT_NAMESPACE,
      key: PRODUKT_KEY,
      type: 'list.metaobject_reference',
      value: JSON.stringify(gids),
    });
  }

  /* 7. Produkte, die im letzten Lauf im Index standen und jetzt nicht mehr. */
  const fruehereProdukte = (await env.REF_CACHE.get(KV_PRODUKTE, { type: 'json' })) || [];
  const jetzige = [...zielProdukt.keys()];
  const entfallen = fruehereProdukte.filter((g) => !zielProdukt.has(g));

  /* 8. Schreiben, metafieldsSet nimmt hoechstens 25 je Aufruf. */
  for (let i = 0; i < zuSetzen.length; i += 25) {
    const teil = zuSetzen.slice(i, i + 25);
    const erg = await graphql(env, M_METAFELDER_SETZEN, { metafields: teil });
    const fehler = userErrors(erg);
    if (fehler.length) {
      protokoll.fehler.push(...fehler.map((f) => `metafieldsSet: ${f.message}`));
    } else {
      protokoll.produkte_geschrieben += teil.length;
    }
  }

  for (let i = 0; i < entfallen.length; i += 25) {
    const teil = entfallen.slice(i, i + 25).map((ownerId) => ({
      ownerId,
      namespace: PRODUKT_NAMESPACE,
      key: PRODUKT_KEY,
    }));
    const erg = await graphql(env, M_METAFELDER_LOESCHEN, { metafields: teil });
    const fehler = userErrors(erg);
    if (fehler.length) {
      protokoll.fehler.push(...fehler.map((f) => `metafieldsDelete: ${f.message}`));
    } else {
      protokoll.produkte_geleert += teil.length;
    }
  }

  /* 9. Branchenpools. */
  for (const [handle, eintrag] of zielPool) {
    const h = await hash(eintrag.gids);
    neueHashes[`pool:${handle}`] = h;
    if (alteHashes[`pool:${handle}`] === h) {
      protokoll.uebersprungen += 1;
      continue;
    }

    const fields = [{ key: projekteFeld.key, value: JSON.stringify(eintrag.gids) }];
    if (nameFeld) fields.push({ key: nameFeld.key, value: eintrag.label });

    const erg = await graphql(env, M_POOL_SCHREIBEN, {
      handle: { type: POOL_TYP, handle },
      metaobject: { fields },
    });
    const fehler = userErrors(erg);
    if (fehler.length) {
      protokoll.fehler.push(...fehler.map((f) => `metaobjectUpsert ${handle}: ${f.message}`));
    } else {
      protokoll.pools_geschrieben += 1;
    }
  }

  /* 10. Stand sichern. Bei Fehlern die Hashes NICHT sichern, sonst gilt ein
         misslungener Schreibvorgang beim naechsten Lauf als erledigt. */
  if (!protokoll.fehler.length) {
    await env.REF_CACHE.put(KV_HASHES, JSON.stringify(neueHashes));
    await env.REF_CACHE.put(KV_PRODUKTE, JSON.stringify(jetzige));
  }

  protokoll.dauer_ms = Date.now() - start;
  protokoll.beendet = new Date().toISOString();
  await env.REF_CACHE.put(KV_LETZTER_LAUF, JSON.stringify(protokoll));

  return protokoll;
}

export async function letzterLauf(env) {
  return env.REF_CACHE.get(KV_LETZTER_LAUF, { type: 'json' });
}
