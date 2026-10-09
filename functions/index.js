// PayPal-Zahlung für die Webshop-Demo auf ycblischke.de/appdesigner/
//
// Der Preis wird ausschließlich hier auf dem Server berechnet - der Browser
// schickt nur die Produkt-IDs. So kann niemand den Betrag manipulieren.
//
// Einrichtung:
//   PAYPAL_CLIENT_ID  -> functions/.env  (öffentlich, steht auch im Browser)
//   PAYPAL_SECRET     -> firebase functions:secrets:set PAYPAL_SECRET
//   PAYPAL_API        -> Sandbox (Test) oder https://api-m.paypal.com (Live)

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'europe-west3', maxInstances: 3 });

const PAYPAL_CLIENT_ID = defineString('PAYPAL_CLIENT_ID');
const PAYPAL_API = defineString('PAYPAL_API', { default: 'https://api-m.sandbox.paypal.com' });
const PAYPAL_SECRET = defineSecret('PAYPAL_SECRET');

// Muss zu PRODUCTS in appdesigner/index.html passen (dort nur zur Anzeige)
const PRODUCTS = {
  'website-basic': { name: 'Website Basic', price: 490 },
  'webshop-setup': { name: 'Online-Shop Setup', price: 1490 },
  'branding':      { name: 'Icon & Branding', price: 290 },
  'wartung':       { name: 'Wartung & Support (1. Monat)', price: 79 },
};

const isSandbox = () => PAYPAL_API.value().includes('sandbox');

async function paypal(path, body) {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID.value()}:${PAYPAL_SECRET.value()}`).toString('base64');
  const tokenRes = await fetch(`${PAYPAL_API.value()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!tokenRes.ok) throw new HttpsError('internal', 'PayPal-Anmeldung fehlgeschlagen');
  const { access_token } = await tokenRes.json();

  const res = await fetch(`${PAYPAL_API.value()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('PayPal-Fehler', path, res.status, JSON.stringify(data));
    throw new HttpsError('internal', 'PayPal hat die Anfrage abgelehnt');
  }
  return data;
}

const eur = n => n.toFixed(2);

// Schritt 1: Zahlung bei PayPal anlegen und als offene Bestellung speichern
exports.createPaypalOrder = onCall({ secrets: [PAYPAL_SECRET] }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  const ids = req.data && req.data.items;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10 ||
      new Set(ids).size !== ids.length || !ids.every(id => PRODUCTS[id])) {
    throw new HttpsError('invalid-argument', 'Ungültiger Warenkorb.');
  }
  const items = ids.map(id => ({ id, ...PRODUCTS[id] }));
  const total = items.reduce((sum, p) => sum + p.price, 0);

  const order = await paypal('/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      description: 'Webshop ycblischke.de',
      amount: {
        currency_code: 'EUR',
        value: eur(total),
        breakdown: { item_total: { currency_code: 'EUR', value: eur(total) } },
      },
      items: items.map(p => ({
        name: p.name,
        quantity: '1',
        unit_amount: { currency_code: 'EUR', value: eur(p.price) },
      })),
    }],
    application_context: {
      brand_name: 'Yves Claudio Blischke',
      locale: 'de-DE',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
    },
  });

  const token = req.auth.token;
  const customer = await db.collection('customers').doc(req.auth.uid).get();
  await db.collection('orders').doc(order.id).set({
    uid: req.auth.uid,
    name: (customer.exists && customer.data().name) || token.name || '',
    email: token.email || '',
    items: items.map(p => ({ id: p.id, name: p.name, price: p.price, unit: '' })),
    total,
    status: 'pending',
    sandbox: isSandbox(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { paypalOrderId: order.id };
});

// Schritt 2: Nach Freigabe durch den Kunden Geld einziehen und prüfen
exports.capturePaypalOrder = onCall({ secrets: [PAYPAL_SECRET] }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  const id = req.data && req.data.paypalOrderId;
  if (typeof id !== 'string' || !/^[A-Z0-9]{5,40}$/.test(id)) {
    throw new HttpsError('invalid-argument', 'Ungültige Zahlung.');
  }
  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().uid !== req.auth.uid) {
    throw new HttpsError('not-found', 'Bestellung nicht gefunden.');
  }
  if (snap.data().status === 'paid') return { status: 'paid' };

  const result = await paypal(`/v2/checkout/orders/${id}/capture`);
  const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
  const ok = result.status === 'COMPLETED' && capture &&
             capture.status === 'COMPLETED' &&
             capture.amount.currency_code === 'EUR' &&
             capture.amount.value === eur(snap.data().total);
  if (!ok) {
    console.error('Zahlung unvollständig', id, JSON.stringify(result));
    await ref.update({ status: 'failed' });
    throw new HttpsError('failed-precondition', 'Die Zahlung konnte nicht abgeschlossen werden.');
  }

  await ref.update({
    status: 'paid',
    paidAt: admin.firestore.FieldValue.serverTimestamp(),
    paypalCaptureId: capture.id,
    payerEmail: result.payer?.email_address || '',
  });
  return { status: 'paid' };
});
