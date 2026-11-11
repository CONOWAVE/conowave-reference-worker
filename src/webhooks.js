/**
 * Webhook-Abos einrichten und anzeigen.
 *
 * Vier Themen auf denselben Endpunkt. Die beiden metaobjects-Themen verlangen
 * zwingend einen Filter in der Form type:projekt, sonst lehnt Shopify das Abo
 * ab. Die beiden articles-Themen aendern am Index sachlich nichts, sie sorgen
 * nur dafuer, dass er in dem Moment steht, in dem jemand einen Beitrag
 * speichert und gleich darauf anschaut.
 *
 * Einrichten ist wiederholbar: vorhandene Abos auf denselben Pfad werden
 * erkannt und nicht doppelt angelegt.
 */

import { graphql, userErrors } from './shopify.js';

const PFAD = '/webhook/shopify';

const GEWUENSCHT = [
  { topic: 'METAOBJECTS_CREATE', filter: 'type:projekt' },
  { topic: 'METAOBJECTS_UPDATE', filter: 'type:projekt' },
  { topic: 'ARTICLES_CREATE', filter: null },
  { topic: 'ARTICLES_UPDATE', filter: null },
];

const Q_ABOS = `
  query Abos {
    webhookSubscriptions(first: 100) {
      nodes {
        id
        topic
        filter
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
      }
    }
  }
`;

const M_ANLEGEN = `
  mutation Anlegen($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id topic filter }
      userErrors { field message }
    }
  }
`;

const M_AENDERN = `
  mutation Aendern($id: ID!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
      webhookSubscription { id topic filter }
      userErrors { field message }
    }
  }
`;

const M_LOESCHEN = `
  mutation Loeschen($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

function callbackUrl(request) {
  return new URL(PFAD, new URL(request.url).origin).toString();
}

function vorhandene(daten) {
  return (daten.webhookSubscriptions?.nodes || []).map((n) => ({
    id: n.id,
    topic: n.topic,
    filter: n.filter || null,
    url: n.endpoint?.callbackUrl || null,
  }));
}

/** Nur anzeigen, was bereits eingerichtet ist. */
export async function aboListe(env) {
  const daten = await graphql(env, Q_ABOS);
  return vorhandene(daten);
}

/**
 * Die vier Abos herstellen. Vorhandene mit abweichendem Filter werden
 * korrigiert, fehlende angelegt, nichts doppelt.
 */
export async function abosEinrichten(env, request) {
  const url = callbackUrl(request);
  const bestand = vorhandene(await graphql(env, Q_ABOS));

  const ergebnis = { endpunkt: url, angelegt: [], korrigiert: [], unveraendert: [], fehler: [] };

  for (const wunsch of GEWUENSCHT) {
    const treffer = bestand.find((b) => b.topic === wunsch.topic && b.url === url);
    const sub = { callbackUrl: url, format: 'JSON' };
    if (wunsch.filter) sub.filter = wunsch.filter;

    if (!treffer) {
      const erg = await graphql(env, M_ANLEGEN, { topic: wunsch.topic, sub });
      const fehler = userErrors(erg);
      if (fehler.length) {
        ergebnis.fehler.push(`${wunsch.topic}: ${fehler.map((f) => f.message).join('; ')}`);
      } else {
        ergebnis.angelegt.push(wunsch.topic);
      }
      continue;
    }

    if ((treffer.filter || null) !== (wunsch.filter || null)) {
      const erg = await graphql(env, M_AENDERN, { id: treffer.id, sub });
      const fehler = userErrors(erg);
      if (fehler.length) {
        ergebnis.fehler.push(`${wunsch.topic} korrigieren: ${fehler.map((f) => f.message).join('; ')}`);
      } else {
        ergebnis.korrigiert.push(`${wunsch.topic}: Filter ${treffer.filter || 'keiner'} -> ${wunsch.filter || 'keiner'}`);
      }
      continue;
    }

    ergebnis.unveraendert.push(wunsch.topic);
  }

  ergebnis.stand = await aboListe(env);
  return ergebnis;
}

/** Alle Abos dieses Workers wieder entfernen. Fuer Umbauten und Tests. */
export async function abosEntfernen(env, request) {
  const url = callbackUrl(request);
  const bestand = vorhandene(await graphql(env, Q_ABOS)).filter((b) => b.url === url);
  const ergebnis = { endpunkt: url, entfernt: [], fehler: [] };

  for (const abo of bestand) {
    const erg = await graphql(env, M_LOESCHEN, { id: abo.id });
    const fehler = userErrors(erg);
    if (fehler.length) {
      ergebnis.fehler.push(`${abo.topic}: ${fehler.map((f) => f.message).join('; ')}`);
    } else {
      ergebnis.entfernt.push(abo.topic);
    }
  }

  return ergebnis;
}
