# conowave-reference-worker

Cloudflare Worker für den Artikelfuß auf conowave.com. Er dreht die Beziehung
zwischen Referenzprojekten und Produkten um und legt das Ergebnis dort ab, wo
Liquid es ohne Suche findet.

Repo: `CONOWAVE/conowave-reference-worker`
Shop: `prfu7j-1q.myshopify.com` (conowave.com)

---

## Warum es den Worker gibt

Am Metaobjekt `projekt` steht `custom.products`, also Projekt zu Produkten.
Der Artikelfuß braucht die Gegenrichtung. Liquid kann die 223 Projekte nicht
durchsuchen, eine Schleife über `metaobjects.projekt.values` bricht bei 50
Einträgen ab. Der Umkehrindex wird deshalb außerhalb des Themes gebaut.

Zwei Ziele:

| Ziel | Inhalt |
|---|---|
| `Produkt.custom.referenzen` | bis zu 6 Projekte je Produkt |
| `referenzpool[branche].projekte` | bis zu 6 Projekte je Branche |

Der Eintrag `referenzpool/standard` wird **nicht** angefasst. Der ist die
redaktionelle Visitenkarte und wird von Hand gepflegt.

---

## Ablauf eines Laufs

1. Zugangstoken über `client_credentials` holen, 24 Stunden gültig, in KV.
2. Feldschlüssel des Metaobjekts `referenzpool` aus der Definition lesen,
   statt sie zu raten. Gesucht wird das Feld vom Typ
   `list.metaobject_reference`.
3. Alle `projekt`-Einträge lesen, 250 je Seite. Gelesen werden `handle`,
   `custom.name`, `custom.branch`, `custom.flagship` und `custom.products`.
   Die Produktverweise kommen als GID-Liste im Rohwert, es braucht keine
   zweite Auflösung.
4. Index A je Produkt und Index B je Branche bilden.
5. Sortieren: Flagship zuerst, danach alphabetisch nach Projektname. Auf sechs
   kappen. Die Reihenfolge ist damit fest und wiederholbar.
6. Je Ziel einen SHA-256 über die Liste bilden und mit dem Hash in KV
   vergleichen. **Nur schreiben, was sich geändert hat.**
7. Schreiben: `metafieldsSet` für die Produkte (25 je Aufruf),
   `metaobjectUpsert` für die Branchenpools.
8. Produkte, die im letzten Lauf im Index standen und jetzt nicht mehr, werden
   über `metafieldsDelete` geleert.
9. Protokoll in KV ablegen, abrufbar unter `/health`.

Punkt 6 ist nicht Kosmetik. Ohne ihn schreibt jeder Lauf alle Produkte neu, das
Änderungsdatum wandert zweimal täglich, und jede Integration an
`products/update` läuft mit.

Schlägt ein Schreibvorgang fehl, werden die Hashes **nicht** gesichert. Sonst
gälte der misslungene Schreibvorgang beim nächsten Lauf als erledigt.

---

## Endpunkte

| Pfad | Zweck |
|---|---|
| `POST /webhook/metaobject` | Shopify-Webhook, HMAC-geprüft, gedrosselt |
| `POST /run` | manueller Anstoß, `Authorization: Bearer <ADMIN_TOKEN>` |
| `POST /run?force=1` | manueller Anstoß ohne Drosselung |
| `GET /health` | Zeitpunkt und Ergebnis des letzten Laufs |

---

## Auslöser

**Cron, zweimal täglich**, `0 5,15 * * *` UTC, also 06:00 und 16:00 deutscher
Zeit im Winter. Grundsicherung, greift auch wenn ein Webhook verloren geht.

**Webhooks** `metaobjects/create` und `metaobjects/update`. Beide verlangen
zwingend einen Filter in der Form `type:projekt`, sonst lehnt Shopify das Abo
ab.

**Drosselung, 120 Sekunden.** Ein Massenimport löst sonst 223 Läufe aus. Wird
ein Ereignis im Fenster abgewiesen, merkt sich der Worker das und läuft gleich
nach dem laufenden Durchgang noch einmal. Nichts geht verloren.

Die Webhook-Nutzlast ist ein Signal, keine Datenquelle. Ihr Inhalt wird nicht
verarbeitet, nur die Signatur geprüft.

---

## Einrichtung

### 1. App-Scopes

Der Worker benutzt die bestehende App **Import-API**. Sie hat bereits
`read_metaobjects`, `write_metaobjects`, `read_metaobject_definitions`,
`write_metaobject_definitions` und `read_products`.

**Es fehlt `write_products`.** Scope erweitern heißt: neue Version im Dev
Dashboard veröffentlichen **und die Installation neu bestätigen**
(„Datenzugriff aktualisieren"). Ohne den zweiten Schritt behält das Token die
alten Scopes. Dieser Stolperstein ist im Projekt bereits mehrfach aufgelaufen.

### 2. KV-Namespace

```
wrangler kv namespace create REF_CACHE
```

Die ausgegebene `id` in `wrangler.toml` eintragen.

### 3. Secrets

```
wrangler secret put SHOPIFY_CLIENT_ID
wrangler secret put SHOPIFY_CLIENT_SECRET
wrangler secret put SHOPIFY_WEBHOOK_SECRET
wrangler secret put ADMIN_TOKEN
```

`SHOPIFY_SHOP` und `SHOPIFY_API_VERSION` stehen als Klartext in
`wrangler.toml`, das sind keine Geheimnisse.

### 4. Ausrollen

Über Cloudflare Builds, verbunden mit diesem Repo (Settings → Builds). **Nicht**
aus dem Dashboard-Editor. Vom Vorgänger `conowave-erp-worker` gibt es bis heute
keinen Quelltext außerhalb von Cloudflare, diesen Fehler wiederholen wir nicht.

### 5. Webhooks anlegen

Nach dem ersten Ausrollen, mit der Worker-URL:

```graphql
mutation {
  webhookSubscriptionCreate(
    topic: METAOBJECTS_UPDATE
    webhookSubscription: {
      callbackUrl: "https://<worker>/webhook/metaobject"
      format: JSON
      filter: "type:projekt"
    }
  ) { userErrors { field message } }
}
```

Dasselbe noch einmal mit `METAOBJECTS_CREATE`.

### 6. Erster Lauf

```
curl -X POST https://<worker>/run?force=1 -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Das Protokoll zeigt unter anderem, wie viele Produkte überhaupt im Index
landen. Aus der Migration ist bekannt, dass die Produktverweise nicht lückenlos
sind: von 21 in WordPress verwendeten Produkten ließen sich nur 10 eindeutig
auf Shopify-Produkte abbilden. Der erste Lauf macht diese Lücken sichtbar.

---

## Wenn etwas schiefgeht

Fällt der Worker aus, veraltet der Index. Nichts bricht, die Seiten zeigen
weiterhin den letzten Stand. Das ist der angenehme Teil daran, das Ergebnis zu
speichern statt live zu berechnen.

Rückweg: `wrangler deploy` einer älteren Version aus Git. Soll der Index ganz
verschwinden, lassen sich die Produkt-Metafelder und die `referenzpool`-
Einträge leeren, dann greift die Vorrangregel der Section eine Stufe tiefer.

Überwachung: `/health` und das Cloudflare-Log. Kein zusätzlicher Alarmweg.

---

## Die Datenlage, die kein Worker heilt

| Branche | Flagship | gesamt |
|---|---|---|
| Store | 64 | 109 |
| Sonstiges | 16 | 35 |
| Shopping Center | 8 | 16 |
| Gastronomie | 5 | 22 |
| Office | 3 | 12 |
| Hotel | 1 | 28 |

Für Hotel gibt es genau eine Vorzeigereferenz. Geplant sind dort mehrere
Beiträge. Entweder ein paar Hotel- und Gastronomieprojekte zu Flagship erheben
oder bewusst aus dem breiteren Bestand wählen. Inhaltliche Aufgabe, unabhängig
von der Technik.
