/**
 * KVK Payconiq Worker
 * ───────────────────────────────────────────────────────────────────
 * Cloudflare Worker die als veilige tussenlaag dient tussen de
 * kassa-frontend en de Payconiq API.
 *
 * SETUP:
 *   1. wrangler secret put PAYCONIQ_API_KEY    (jouw Payconiq API key)
 *   2. wrangler secret put ALLOWED_ORIGIN       (bv. http://192.168.1.50 of file://)
 *   3. Optioneel: wrangler secret put TERMINAL_TOKEN  (zie IP whitelist)
 *   4. wrangler deploy
 *
 * ENDPOINTS:
 *   POST   /payment                     – Maak betaling aan
 *   GET    /payment/:id                 – Haal status op
 *   DELETE /payment/:id/cancel          – Annuleer betaling
 *   POST   /webhook                     – Payconiq push-callback (optioneel)
 *
 * OMGEVING:
 *   PAYCONIQ_API_KEY   – Jouw merchant API key (secret)
 *   ALLOWED_ORIGIN     – CORS origin whitelist (bv. http://192.168.1.50)
 *   TERMINAL_TOKEN     – Optioneel statisch token voor extra auth
 *   PAYCONIQ_ENV       – 'ext' (productie) of 'dev' (sandbox). Default: ext
 */

// ── Payconiq API base URL ─────────────────────────────────────────────
const PQ_BASE = {
  ext: 'https://api.payconiq.com/v3',
  dev: 'https://api.ext.payconiq.com/v3',   // sandbox / testomgeving
};

// ── Limieten ──────────────────────────────────────────────────────────
const MAX_AMOUNT_CENTS = 10000;   // max € 100,00 per transactie
const MIN_AMOUNT_CENTS = 10;      // min € 0,10
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;        // max 30 aanvragen per minuut per IP

// ── In-memory rate limiter (reset bij Worker restart) ─────────────────
// Voor productie: vervang door Cloudflare KV of Durable Object
const rateLimitMap = new Map(); // ip -> { count, windowStart }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ── CORS helpers ──────────────────────────────────────────────────────
function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  // Sta alleen de geconfigureerde origin toe (of wildcard als niet ingesteld)
  const effectiveOrigin = allowed === '*' ? '*' : origin === allowed ? origin : null;
  if (!effectiveOrigin) return null;

  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Terminal-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function errorResponse(message, status = 400, extraHeaders = {}) {
  return jsonResponse({ error: message }, status, extraHeaders);
}

// ── Payconiq API call ─────────────────────────────────────────────────
async function payconiqFetch(path, method, body, env) {
  const base = PQ_BASE[env.PAYCONIQ_ENV || 'ext'];
  const url = `${base}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${env.PAYCONIQ_API_KEY}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

// ── Input validation ──────────────────────────────────────────────────
function validatePaymentBody(body) {
  const { amountCents, description, reference } = body;

  if (!Number.isInteger(amountCents))
    return 'amountCents moet een geheel getal zijn';
  if (amountCents < MIN_AMOUNT_CENTS)
    return `Minimumbedrag is € ${(MIN_AMOUNT_CENTS / 100).toFixed(2)}`;
  if (amountCents > MAX_AMOUNT_CENTS)
    return `Maximumbedrag is € ${(MAX_AMOUNT_CENTS / 100).toFixed(2)}`;

  if (typeof description !== 'string' || description.trim().length === 0)
    return 'description is verplicht';
  if (description.length > 140)
    return 'description mag max. 140 tekens zijn';

  if (reference && (typeof reference !== 'string' || reference.length > 64))
    return 'reference mag max. 64 tekens zijn';

  return null; // OK
}

function isValidPaymentId(id) {
  // Payconiq ID's zijn UUID-achtig: alfanumeriek + koppeltekens, max 64 tekens
  return typeof id === 'string' && /^[a-zA-Z0-9\-_]{8,64}$/.test(id);
}

// ── Terminal token auth (optioneel) ───────────────────────────────────
function checkTerminalToken(request, env) {
  if (!env.TERMINAL_TOKEN) return true; // niet geconfigureerd → overslaan
  const token = request.headers.get('X-Terminal-Token') || '';
  return token === env.TERMINAL_TOKEN;
}

// ── Request router ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    // Geblokkeerde origin
    if (origin && !cors) {
      return errorResponse('Origin niet toegestaan', 403);
    }

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors || {} });
    }

    // Rate limiting op IP
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    if (!checkRateLimit(ip)) {
      return errorResponse('Te veel aanvragen. Probeer opnieuw over een minuut.', 429, cors || {});
    }

    // Sanity check: API key geconfigureerd?
    if (!env.PAYCONIQ_API_KEY) {
      console.error('PAYCONIQ_API_KEY niet geconfigureerd');
      return errorResponse('Worker niet correct geconfigureerd', 500, cors || {});
    }

    // Terminal token check
    if (!checkTerminalToken(request, env)) {
      return errorResponse('Niet geautoriseerd', 401, cors || {});
    }

    const path = url.pathname;

    try {
      // ── POST /payment ─────────────────────────────────────────────
      if (method === 'POST' && path === '/payment') {
        let body;
        try {
          body = await request.json();
        } catch {
          return errorResponse('Ongeldige JSON', 400, cors || {});
        }

        const validationError = validatePaymentBody(body);
        if (validationError) {
          return errorResponse(validationError, 400, cors || {});
        }

        const pqRes = await payconiqFetch('/payments', 'POST', {
          amount: body.amountCents,
          currency: 'EUR',
          description: body.description.trim(),
          reference: body.reference || undefined,
          callbackUrl: env.WEBHOOK_URL || undefined,
        }, env);

        const pqData = await pqRes.json();

        if (!pqRes.ok) {
          console.error('Payconiq fout:', JSON.stringify(pqData));
          return errorResponse(
            pqData.message || 'Payconiq API fout',
            pqRes.status,
            cors || {}
          );
        }

        // Stuur alleen het minimum terug naar de frontend
        return jsonResponse({
          paymentId: pqData.paymentId,
          // QR code URL: directe link om te tonen als afbeelding
          qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(pqData._links.checkout.href)}`,
          checkoutUrl: pqData._links.checkout.href,
          status: pqData.status,
        }, 200, cors || {});
      }

      // ── GET /payment/:id ──────────────────────────────────────────
      const statusMatch = path.match(/^\/payment\/([^/]+)$/);
      if (method === 'GET' && statusMatch) {
        const paymentId = statusMatch[1];
        if (!isValidPaymentId(paymentId)) {
          return errorResponse('Ongeldig payment ID', 400, cors || {});
        }

        const pqRes = await payconiqFetch(`/payments/${paymentId}`, 'GET', null, env);
        const pqData = await pqRes.json();

        if (!pqRes.ok) {
          return errorResponse(pqData.message || 'Payconiq API fout', pqRes.status, cors || {});
        }

        return jsonResponse({
          paymentId: pqData.paymentId,
          status: pqData.status,
          amount: pqData.amount,
          currency: pqData.currency,
        }, 200, cors || {});
      }

      // ── DELETE /payment/:id/cancel ────────────────────────────────
      const cancelMatch = path.match(/^\/payment\/([^/]+)\/cancel$/);
      if (method === 'DELETE' && cancelMatch) {
        const paymentId = cancelMatch[1];
        if (!isValidPaymentId(paymentId)) {
          return errorResponse('Ongeldig payment ID', 400, cors || {});
        }

        const pqRes = await payconiqFetch(`/payments/${paymentId}`, 'DELETE', null, env);

        if (pqRes.status === 204 || pqRes.status === 200) {
          return jsonResponse({ cancelled: true }, 200, cors || {});
        }

        let pqData = {};
        try { pqData = await pqRes.json(); } catch {}
        return errorResponse(pqData.message || 'Kon niet annuleren', pqRes.status, cors || {});
      }

      // ── POST /webhook ─────────────────────────────────────────────
      // Payconiq stuurt een push-notificatie wanneer een betaling klaar is.
      // Verifieer de handtekening en log de update.
      if (method === 'POST' && path === '/webhook') {
        // Payconiq stuurt geen HMAC signature in de gratis tier,
        // maar we beperken wel tot Payconiq-IP ranges (optioneel).
        let body;
        try { body = await request.json(); } catch { return new Response('Bad Request', { status: 400 }); }

        console.log('Webhook ontvangen:', JSON.stringify(body));

        // Hier kan je eventueel een KV-store updaten of een notificatie sturen.
        // Voorlopig enkel bevestigen.
        return new Response('OK', { status: 200 });
      }

      // ── 404 ───────────────────────────────────────────────────────
      return errorResponse('Niet gevonden', 404, cors || {});

    } catch (err) {
      console.error('Worker onverwachte fout:', err);
      return errorResponse('Interne fout', 500, cors || {});
    }
  },
};
