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
| `POST /webhook/shopify` | Shopify-Webhook, HMAC-geprüft, gedrosselt (Zweitname `/webhook/metaobject`) |
| `POST /run` | manueller Anstoß, `Authorization: Bearer <ADMIN_TOKEN>` |
| `POST /run?force=1` | manueller Anstoß ohne Drosselung |
| `GET /health` | Zeitpunkt und Ergebnis des letzten Laufs |

---

## Auslöser

**Kein Cron.** Das Konto ist auf Workers Free und hat die fünf Cron-Trigger je
Konto bereits ausgeschöpft. Der Deploy scheitert sonst mit Fehler 10072.

**Drei Webhook-Abos auf denselben Endpunkt**, alle mit Filter `type:projekt`:

| Thema | wofür |
|---|---|
| `metaobjects/create` | neues Projekt |
| `metaobjects/update` | Projekt geändert, etwa Produkte oder Flagship |
| `metaobjects/delete` | gelöschtes Projekt fällt aus dem Index |

Der Filter ist nicht optional, ohne ihn lehnt Shopify das Abo ab.

**Shopify hat keine Webhooks für Blogbeiträge.** Von 223 Themen in
API-Version 2026-04 passt kein einziges auf ARTICLE, BLOG oder PAGE. Ein
früherer Plan, den Index beim Speichern eines Beitrags anzustoßen, ist damit
hinfällig. Praktisch ist das kein Verlust, der Index hängt allein an den
Projekten.

Einrichten über den Worker selbst:

```
POST /webhooks    stellt die Abos her, wiederholbar
GET  /webhooks    zeigt den Bestand
GET  /webhooks?themen=   zeigt die Themennamen dieser API-Version
DELETE /webhooks  entfernt alle Abos, die auf diesen Worker zeigen
```

**Drosselung, 120 Sekunden.** Ein Massenimport löst sonst 223 Läufe aus. Wird
ein Ereignis im Fenster abgewiesen, merkt sich der Worker das und läuft gleich
nach dem laufenden Durchgang noch einmal. Nichts geht verloren.

Die Webhook-Nutzlast ist ein Signal, keine Datenquelle. Ihr Inhalt wird nicht
verarbeitet, nur die Signatur geprüft.

### Das Netz, vorerst über n8n

Ohne Cron veraltet der Index, wenn ein Webhook ausfällt, bis zur nächsten
Projektänderung. Deshalb ruft n8n stündlich zur Minute 41
`POST /run?force=1` auf. Minute 41, damit der Lauf nicht mit den anderen
CONOWAVE-Zeitplänen kollidiert.

Stündlich ist unbedenklich, weil der Lauf Prüfsummen vergleicht und nur
schreibt, was sich geändert hat. Ein Lauf ohne Änderungen rührt kein
einziges Metafeld an und braucht unter einer Sekunde.

`n8n-referenz-index-lauf.json` im Repo lässt sich in n8n importieren. Der
Zugang läuft über ein Header-Auth-Credential, Name `Authorization`, Wert
`Bearer <ADMIN_TOKEN>`. Der Token steht nicht in der Datei.

**Das ist eine Übergangslösung.** Sobald Workers Paid gebucht ist, die beiden
auskommentierten Zeilen in `wrangler.toml` wieder aktivieren und den
n8n-Ablauf abschalten. Nicht beides laufen lassen, das verdoppelt nur die
Schreibvorgänge ohne Nutzen.

---

## Einrichtung

### 1. App-Scopes

Der Worker benutzt die bestehende App **Import-API**,
Client-ID `ca8442cc5d35997e2bdb633f838386f4`. Seit Version `import-api-8`
hat sie alle noetigen Rechte, darunter `read_metaobjects`,
`write_metaobjects`, `read_products` und `write_products`.

**Falls Scopes später erneut erweitert werden:** neue Version im Dev
Dashboard veröffentlichen, die Installation im Shop neu bestätigen
(„Datenzugriff aktualisieren") **und** das zwischengespeicherte Token mit
`?token=neu` verwerfen. Fehlt einer dieser drei Schritte, arbeitet der Worker
still mit den alten Rechten weiter. Shopify liefert bei fehlendem Recht keine
Fehlermeldung, sondern eine leere Liste.

### 2. KV-Namespace

```
wrangler kv namespace create REF_CACHE
```

Die ausgegebene `id` in `wrangler.toml` eintragen. Angelegt ist
`conowave-reference-worker-REF_CACHE`, ID `2dd45716a7a542a39c4885544ed46ee9`.

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

Am einfachsten über den Worker selbst, siehe oben. Von Hand ginge es so:

```graphql
mutation {
  webhookSubscriptionCreate(
    topic: METAOBJECTS_UPDATE
    webhookSubscription: {
      callbackUrl: "https://<worker>/webhook/shopify"
      format: JSON
      filter: "type:projekt"
    }
  ) { userErrors { field message } }
}
```

Einfacher ist `POST /webhooks`, siehe oben.

### 6. Erster Lauf

```
curl -X POST https://<worker>/run?force=1 -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Der erste Lauf am 11.11.2026 ergab: 223 Projekte gelesen, 10 Produkte im
Index, 6 Branchenpools geschrieben, keine Fehler, 3,1 Sekunden.

Die 10 bestätigen den Migrationsbefund: von 21 in WordPress verwendeten
Produkten ließen sich nur 10 eindeutig auf Shopify-Produkte abbilden. Für
Quelle 3 des Artikelfußes heißt das, sie greift nur bei Kollektionen, die
eines dieser 10 Produkte enthalten. Das ist Pflegearbeit an den Projekten,
nichts Technisches.

---

## Wenn etwas schiefgeht

Fällt der Worker aus, veraltet der Index. Nichts bricht, die Seiten zeigen
weiterhin den letzten Stand. Das ist der angenehme Teil daran, das Ergebnis zu
speichern statt live zu berechnen.

Rückweg: `wrangler deploy` einer älteren Version aus Git. Soll der Index ganz
verschwinden, lassen sich die Produkt-Metafelder und die `referenzpool`-
Einträge leeren, dann greift die Vorrangregel der Section eine Stufe tiefer.

Überwachung: `/health` und das Cloudflare-Log. Kein zusätzlicher Alarmweg.

Ohne Cron gibt es kein Netz für verlorene Webhooks. Fällt einer aus, bleibt der
Index so lange veraltet, bis das nächste Projekt oder der nächste Beitrag
gespeichert wird. Notfalls `POST /run?force=1`.

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
