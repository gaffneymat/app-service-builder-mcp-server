// Invented shop data for the demo. Every brand, product, price, store and order here is
// fictional; nothing is read from or written to a real system.

export const SHOP = 'Northlight Cameras';
export const STORES = ['Stockholm', 'Göteborg', 'Malmö', 'Uppsala', 'Online warehouse'];

const P = (id, name, category, brand, priceSek, mount, specs, stock, extra = {}) => ({
  id, name, category, brand, priceSek, mount, specs, stock: Object.fromEntries(STORES.map((s, i) => [s, stock[i]])), ...extra,
});

export const PRODUCTS = [
  P('LUM-Z5', 'Lumora Z5', 'camera', 'Lumora', 14990, 'Lumora ZX', '24 MP full-frame mirrorless, 4K60 video, in-body stabilisation, 640 g', [3, 1, 0, 2, 14],
    { tags: ['mirrorless', 'full-frame', 'all-round', 'travel'] }),
  P('LUM-Z7', 'Lumora Z7', 'camera', 'Lumora', 27990, 'Lumora ZX', '45 MP full-frame mirrorless, 8K video, weather sealed, 780 g', [1, 0, 1, 0, 4],
    { tags: ['mirrorless', 'full-frame', 'professional', 'landscape'] }),
  P('LUM-C2', 'Lumora C2', 'camera', 'Lumora', 8490, null, '1-inch 20 MP compact, 24-200 mm zoom built in, pocket size, 340 g', [5, 3, 2, 1, 22],
    { tags: ['compact', 'travel', 'beginner'] }),
  P('KES-K30', 'Kestrel K30', 'camera', 'Kestrel', 11490, 'Kestrel K', '26 MP APS-C mirrorless, fast autofocus for kids and pets, 450 g', [0, 2, 4, 1, 9],
    { tags: ['mirrorless', 'aps-c', 'beginner', 'family'] }),
  P('KES-K90', 'Kestrel K90', 'camera', 'Kestrel', 19990, 'Kestrel K', '40 MP APS-C mirrorless, 30 fps bursts for sport and wildlife, 610 g', [2, 0, 0, 1, 3],
    { tags: ['mirrorless', 'aps-c', 'sport', 'wildlife'] }),
  P('AUR-V1', 'Aurion V1', 'camera', 'Aurion', 6990, null, '1-inch vlog camera, flip screen, built-in mic array, 290 g', [4, 4, 3, 2, 18],
    { tags: ['compact', 'vlog', 'video', 'beginner'] }),
  P('LUM-2470', 'Lumora ZX 24-70 mm f/4', 'lens', 'Lumora', 9990, 'Lumora ZX', 'Standard zoom, weather sealed, 500 g', [2, 1, 1, 0, 6],
    { tags: ['zoom', 'standard', 'all-round'] }),
  P('LUM-50', 'Lumora ZX 50 mm f/1.8', 'lens', 'Lumora', 2990, 'Lumora ZX', 'Light prime for portraits and low light, 180 g', [6, 2, 3, 2, 25],
    { tags: ['prime', 'portrait', 'low-light'] }),
  P('LUM-100400', 'Lumora ZX 100-400 mm f/4.5-5.6', 'lens', 'Lumora', 16490, 'Lumora ZX', 'Telephoto zoom for wildlife and sport, 1.4 kg', [0, 1, 0, 0, 2],
    { tags: ['telephoto', 'wildlife', 'sport'] }),
  P('KES-18135', 'Kestrel K 18-135 mm', 'lens', 'Kestrel', 5490, 'Kestrel K', 'Everyday travel zoom, 330 g', [3, 2, 2, 1, 11],
    { tags: ['zoom', 'travel', 'all-round'] }),
  P('KES-35', 'Kestrel K 35 mm f/1.4', 'lens', 'Kestrel', 6990, 'Kestrel K', 'Bright prime for street and portraits, 300 g', [1, 0, 2, 0, 5],
    { tags: ['prime', 'street', 'portrait', 'low-light'] }),
  P('VAN-28200-ZX', 'Vanta 28-200 mm (Lumora ZX)', 'lens', 'Vanta', 7490, 'Lumora ZX', 'One-lens travel zoom, 575 g', [2, 1, 2, 0, 7],
    { tags: ['zoom', 'travel'] }),
  P('VAN-28200-K', 'Vanta 28-200 mm (Kestrel K)', 'lens', 'Vanta', 7490, 'Kestrel K', 'One-lens travel zoom, 575 g', [0, 1, 1, 1, 4],
    { tags: ['zoom', 'travel'] }),
  P('ACC-TRI', 'Trailhead carbon travel tripod', 'accessory', 'Trailhead', 3290, null, 'Carbon fibre, folds to 40 cm, carries 8 kg, 1.2 kg', [4, 2, 1, 1, 12],
    { tags: ['tripod', 'travel', 'landscape'] }),
  P('ACC-SD128', 'Velox 128 GB SD card V60', 'accessory', 'Velox', 449, null, 'UHS-II, fast enough for 4K video', [30, 18, 12, 9, 140],
    { tags: ['memory', 'video'] }),
  P('ACC-BPZ', 'Lumora BP-Z battery', 'accessory', 'Lumora', 899, 'Lumora ZX', 'Spare battery for Lumora Z5 and Z7', [8, 3, 2, 2, 40],
    { tags: ['battery'] }),
  P('ACC-BAG', 'Fjord sling camera bag', 'accessory', 'Fjord', 1290, null, 'Fits one camera and two lenses, rain cover', [5, 4, 4, 2, 26],
    { tags: ['bag', 'travel'] }),
];

export const ORDERS = {
  'NL-10482': { status: 'Shipped', placed: '2026-11-15', items: ['LUM-Z5', 'ACC-SD128'], detail: 'Handed to the carrier on 17 Nov, tracking NLX4820917, expected delivery 20 Nov.' },
  'NL-10511': { status: 'Waiting for stock', placed: '2026-11-17', items: ['LUM-100400'], detail: 'Lens is on its way from the supplier; we expect it in the online warehouse on 24 Nov and ship the same day.' },
  'NL-10533': { status: 'Ready for pickup', placed: '2026-11-18', items: ['KES-K30', 'KES-18135'], detail: 'Waiting at the Malmö store. Bring ID. Held until 2 Dec.' },
  'NL-10390': { status: 'Refunded', placed: '2026-11-02', items: ['AUR-V1'], detail: 'Return received on 12 Nov, 6,990 SEK refunded to the original card on 13 Nov.' },
};

const summary = (p) => ({ id: p.id, name: p.name, category: p.category, priceSek: p.priceSek, mount: p.mount, inStockTotal: Object.values(p.stock).reduce((a, b) => a + b, 0) });
const normal = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

export function searchProducts({ query, category, maxPriceSek, mount } = {}) {
  const words = normal(query).split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const hits = PRODUCTS.filter((p) => (!category || p.category === category)
    && (maxPriceSek === undefined || p.priceSek <= maxPriceSek)
    && (!mount || normal(p.mount) === normal(mount)))
    .map((p) => {
      const hay = normal(`${p.name} ${p.brand} ${p.specs} ${p.tags.join(' ')} ${p.mount ?? ''}`);
      return { p, score: words.length ? words.filter((w) => hay.includes(w)).length : 1 };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.p.priceSek - b.p.priceSek)
    .slice(0, 8)
    .map((h) => summary(h.p));
  return { count: hits.length, products: hits };
}

export function getProduct({ productId }) {
  const p = PRODUCTS.find((x) => x.id === productId);
  if (!p) return { error: 'unknown_product', productId };
  const fits = p.category === 'camera' && p.mount
    ? PRODUCTS.filter((x) => x.mount === p.mount && x.id !== p.id && x.category !== 'camera').map(summary) : [];
  return { ...summary(p), brand: p.brand, specs: p.specs, compatibleLensesAndAccessories: fits };
}

export function checkStock({ productId, store }) {
  const p = PRODUCTS.find((x) => x.id === productId);
  if (!p) return { error: 'unknown_product', productId };
  const match = store ? STORES.find((s) => normal(s) === normal(store)) : undefined;
  if (store && !match) return { error: 'unknown_store', store, stores: STORES };
  const rows = Object.entries(p.stock).filter(([s]) => !match || s === match).map(([s, n]) => ({ store: s, units: n }));
  return { productId: p.id, name: p.name, stock: rows, note: 'Online warehouse ships in 1-2 working days.' };
}

export function getOrderStatus({ orderNumber }) {
  const key = String(orderNumber ?? '').trim().toUpperCase();
  const o = ORDERS[key];
  if (!o) return { error: 'unknown_order', orderNumber: key, hint: 'Demo orders: NL-10482, NL-10511, NL-10533, NL-10390' };
  return { orderNumber: key, ...o, items: o.items.map((id) => summary(PRODUCTS.find((p) => p.id === id))) };
}

/** Product ids mentioned anywhere in a tool result, for the page's product shelf. */
export function productsIn(value) {
  const text = JSON.stringify(value);
  return PRODUCTS.filter((p) => text.includes(`"${p.id}"`)).map((p) => ({ ...summary(p), specs: p.specs, stock: p.stock }));
}
