# KVK Kassa – Payconiq integratie

Lokale barkassa voor Kunst Veredelt Kieldrecht, met Payconiq QR-betalingen.

## Bestandsstructuur

```
kvk-bar/
  index.html    – Frontend (tablet-kassa), draait lokaal
  worker.js     – Cloudflare Worker (backend / Payconiq-proxy)
  wrangler.toml – Worker configuratie
```

---

## 1. Cloudflare Worker deployen

### Vereisten
- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account (gratis tier volstaat)
- Payconiq merchant-account + API key

### Stappen

```bash
# 1. Aanmelden bij Cloudflare
wrangler login

# 2. Secrets instellen (NOOIT in wrangler.toml!)
wrangler secret put PAYCONIQ_API_KEY
# → plak je Payconiq API key

wrangler secret put ALLOWED_ORIGIN
# → bv. http://192.168.1.50  (IP van de tablet op het lokale netwerk)
# → of file:// als je index.html gewoon opent vanuit de Verkenner

wrangler secret put TERMINAL_TOKEN
# → verzin een willekeurige string, bv. "kvk-geheim-2025"
#   (deze zet je ook in index.html bij de fetch-header)

# 3. Deployen
wrangler deploy

# Je Worker-URL verschijnt: https://kvk-payconiq.JOUW-NAAM.workers.dev
```

---

## 2. Frontend instellen

Open `index.html` en pas bovenaan in het `<script>` blok aan:

```js
const WORKER_URL = 'https://kvk-payconiq.JOUW-NAAM.workers.dev';
```

Als je `TERMINAL_TOKEN` hebt ingesteld, voeg dan ook toe aan de fetch-aanroep
in `initPayment()`:

```js
headers: {
  'Content-Type': 'application/json',
  'X-Terminal-Token': 'kvk-geheim-2025',  // zelfde waarde als het secret
},
```

---

## 3. Lokaal draaien (geen server nodig)

De `index.html` is een volledig zelfstandig bestand.
Open het gewoon in een browser op de tablet:

```
# Windows / macOS: dubbelklik op index.html
# Of via lokale server (optioneel):
npx serve .
```

Zorg dat de tablet en de Worker-URL bereikbaar zijn
(Worker draait in de cloud, dus internetverbinding nodig).

---

## 4. Prijslijst aanpassen

Zoek in `index.html` het `MENU`-object (bovenaan in het script) en pas
de categorieën, namen, prijzen en iconen aan:

```js
const MENU = [
  {
    cat: 'Bieren',
    icon: '🍺',
    items: [
      { name: 'Pils',   price: 2.50, icon: '🍺' },
      { name: 'Tripel', price: 3.00, icon: '🍺' },
      // ...
    ]
  },
  // ...
];
```

---

## 5. Sandbox testen

Zet in `wrangler.toml`:
```toml
PAYCONIQ_ENV = "dev"
```
En gebruik de Payconiq sandbox API key. Zo kan je betalingen testen
zonder echte rekeningen.

Zet terug op `"ext"` voor productie.

---

## Security-overzicht

| Maatregel              | Hoe                                              |
|------------------------|--------------------------------------------------|
| API key beschermd      | Alleen in Worker secrets, nooit in frontend       |
| CORS origin-whitelist  | `ALLOWED_ORIGIN` secret in Worker                |
| Terminal token         | `X-Terminal-Token` header + `TERMINAL_TOKEN` secret |
| Rate limiting          | Max 30 req/min per IP (in-memory)                |
| Input validatie        | Bedrag, omschrijving en ID worden gevalideerd     |
| Payment ID validatie   | Regex op alfanumeriek formaat                    |
| Max. transactiebedrag  | Hardcoded € 200,00 in Worker                     |
| HTTPS                  | Cloudflare Workers draaien altijd op HTTPS        |

---

## Limieten aanpassen

In `worker.js`:
```js
const MAX_AMOUNT_CENTS = 20000;  // € 200,00
const MIN_AMOUNT_CENTS = 10;     // € 0,10
const RATE_LIMIT_MAX   = 30;     // aanvragen per minuut
```
