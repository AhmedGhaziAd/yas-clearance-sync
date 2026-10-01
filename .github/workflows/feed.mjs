// ============================================================================
//  ebarza -> ChatGPT (OpenAI Ads) product feed - runs on GitHub Actions.
//  1. Asks Shopify for ALL active products (bulk export, any catalog size)
//  2. Builds one row per variant in OpenAI's feed format
//  3. Writes out/feed.tsv  (the workflow publishes it to the "feed" branch)
//  Needs env SHOPIFY_ADMIN_TOKEN with scopes: read_products, read_inventory
//  Local test without Shopify:  node feed.mjs --from sample.jsonl
// ============================================================================
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const SHOP = 'ebarza.myshopify.com';
const API = '2025-10';
const SITE = 'https://www.ebarza.com';
const BRAND = 'ebarza';
const CURRENCY = 'AED';
const COUNTRY = 'AE';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors));
  return json.data;
}

const BULK_QUERY = `{
  products(query: "status:active") {
    edges { node {
      id title handle description productType onlineStoreUrl isGiftCard
      media { edges { node { ... on MediaImage { id image { url } } } } }
      variants { edges { node {
        id sku barcode title price compareAtPrice availableForSale inventoryQuantity
        selectedOptions { name value }
      } } }
    } }
  }
}`;

async function bulkExport() {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) throw new Error('Missing env SHOPIFY_ADMIN_TOKEN');
  const start = await gql(
    `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id } userErrors { message } } }`,
    { q: BULK_QUERY });
  const errs = start.bulkOperationRunQuery.userErrors;
  if (errs.length) throw new Error('Bulk start: ' + JSON.stringify(errs));
  for (let i = 0; i < 120; i++) {               // up to ~10 min
    await sleep(5000);
    const d = await gql(`{ currentBulkOperation { status errorCode objectCount url } }`);
    const op = d.currentBulkOperation;
    console.log(`bulk: ${op.status} (${op.objectCount} objects)`);
    if (op.status === 'COMPLETED') {
      if (!op.url) return '';                   // store has no matching products
      const r = await fetch(op.url);
      if (!r.ok) throw new Error('Download failed HTTP ' + r.status);
      return await r.text();
    }
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(op.status)) throw new Error('Bulk ' + op.status + ' ' + op.errorCode);
  }
  throw new Error('Bulk export timed out');
}

// ---- turn Shopify JSONL into products with their variants + images --------
function parse(jsonl) {
  const products = new Map();
  const lines = jsonl.split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const o of lines) if (!o.__parentId) products.set(o.id, { ...o, variants: [], images: [] });
  for (const o of lines) {
    const p = o.__parentId && products.get(o.__parentId);
    if (!p) continue;
    if (o.id?.includes('/ProductVariant/')) p.variants.push(o);
    else if (o.image?.url) p.images.push(o.image.url);
  }
  return [...products.values()];
}

// ---- helpers --------------------------------------------------------------
const num = gid => String(gid).split('/').pop();
const clean = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().replace(/^"+/, '');
const money = n => `${Number(n).toFixed(2)} ${CURRENCY}`;
const validGtin = b => /^\d{8}$|^\d{12,14}$/.test(String(b || ''));

const COLUMNS = [
  'item_id', 'group_id', 'listing_has_variations', 'variant_dict', 'title', 'description', 'url',
  'brand', 'image_url', 'additional_image_urls', 'price', 'sale_price', 'availability', 'condition',
  'product_category', 'mpn', 'gtin', 'seller_name', 'seller_url', 'return_policy',
  'seller_privacy_policy', 'seller_tos', 'target_countries', 'store_country',
  'is_eligible_search', 'is_eligible_checkout', 'is_ads_eligible',
];

function rows(products) {
  const out = [];
  const skipped = { notOnline: 0, giftCard: 0, noImage: 0, noPrice: 0 };
  for (const p of products) {
    if (p.isGiftCard) { skipped.giftCard++; continue; }
    if (!p.onlineStoreUrl) { skipped.notOnline++; continue; }   // not published on the website
    if (!p.images.length) { skipped.noImage++; continue; }
    const base = p.onlineStoreUrl.replace(/^https?:\/\/[^/]+/, SITE);
    const multi = p.variants.length > 1;
    for (const v of p.variants) {
      const price = Number(v.price), compare = Number(v.compareAtPrice || 0);
      if (!(price > 0)) { skipped.noPrice++; continue; }
      const onSale = compare > price;
      const opts = (v.selectedOptions || []).filter(o => !(o.name === 'Title' && o.value === 'Default Title'));
      const availability = !v.availableForSale ? 'out_of_stock'
        : (v.inventoryQuantity ?? 1) > 0 ? 'in_stock' : 'backorder';   // "continue selling" items
      out.push({
        item_id: num(v.id),
        group_id: num(p.id),
        listing_has_variations: multi ? 'true' : 'false',
        variant_dict: opts.length ? JSON.stringify(Object.fromEntries(opts.map(o => [o.name, o.value]))) : '',
        title: clean(multi && v.title !== 'Default Title' ? `${p.title} - ${v.title}` : p.title).slice(0, 150),
        description: clean(p.description || p.title).slice(0, 5000),
        url: `${base}?variant=${num(v.id)}`,
        brand: BRAND,
        image_url: p.images[0],
        additional_image_urls: p.images.slice(1, 10).join(','),
        price: money(onSale ? compare : price),
        sale_price: onSale ? money(price) : '',
        availability,
        condition: 'new',
        product_category: clean(p.productType),
        mpn: clean(v.sku),
        gtin: validGtin(v.barcode) ? v.barcode : '',
        seller_name: BRAND,
        seller_url: SITE,
        return_policy: `${SITE}/policies/refund-policy`,
        seller_privacy_policy: `${SITE}/policies/privacy-policy`,
        seller_tos: `${SITE}/policies/terms-of-service`,
        target_countries: JSON.stringify([COUNTRY]),
        store_country: COUNTRY,
        is_eligible_search: 'true',
        is_eligible_checkout: 'false',
        is_ads_eligible: availability === 'out_of_stock' ? 'false' : 'true',
      });
    }
  }
  return { out, skipped };
}

(async () => {
  const fromIdx = process.argv.indexOf('--from');
  const jsonl = fromIdx > 0 ? readFileSync(process.argv[fromIdx + 1], 'utf8') : await bulkExport();
  const products = parse(jsonl);
  const { out, skipped } = rows(products);
  if (fromIdx < 0 && out.length < 10) throw new Error(`Only ${out.length} rows - refusing to publish a broken feed`);

  const tsv = [COLUMNS.join('\t'), ...out.map(r => COLUMNS.map(c => clean(r[c])).join('\t'))].join('\n') + '\n';
  mkdirSync('out', { recursive: true });
  writeFileSync('out/feed.tsv', tsv, 'utf8');
  const inStock = out.filter(r => r.availability !== 'out_of_stock').length;
  console.log(`${products.length} products -> ${out.length} rows (${inStock} sellable). Skipped: ${JSON.stringify(skipped)}. ${(tsv.length / 1024).toFixed(0)} KB`);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
