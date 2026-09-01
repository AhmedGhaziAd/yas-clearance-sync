// ============================================================================
//  Yas Clearance cloud sync - runs on GitHub Actions every 15 minutes.
//  1. Reads available qty at YAS STOCK + YAS DISPLAY NOT FOR SALE
//  2. Reads the YAS SHOWROOM PRODUCTS collection (in its sort order)
//  3. Builds window.YAS_CLEARANCE = [...] with summed qty per product
//  4. Uploads assets/yas-clearance-products.js straight to the live theme
//  Requires env SHOPIFY_ADMIN_TOKEN with scopes:
//    read_products, read_inventory, read_locations, write_themes
// ============================================================================

const SHOP = 'ebarza.myshopify.com';
const API  = '2024-04';
const THEME_ID = '149057896599';
const ASSET_KEY = 'assets/yas-clearance-products.js';

const COLLECTION  = 'gid://shopify/Collection/315089223831';
const YAS_STOCK   = 'gid://shopify/Location/66392719511';
const YAS_DISPLAY = 'gid://shopify/Location/66392686743';

const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
if (!TOKEN) { console.error('Missing env SHOPIFY_ADMIN_TOKEN'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors));
  return json.data;
}

const LEVELS = `
  query($loc: ID!, $cursor: String) {
    location(id: $loc) {
      inventoryLevels(first: 250, after: $cursor) {
        nodes {
          quantities(names: ["available"]) { quantity }
          item { variant { product { id } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

async function qtyMap(locId, label) {
  const map = new Map();
  let cursor = null, page = 0;
  while (true) {
    const d = await gql(LEVELS, { loc: locId, cursor });
    const conn = d.location?.inventoryLevels;
    if (!conn) break;
    for (const n of conn.nodes) {
      const id = n.item?.variant?.product?.id;
      if (!id) continue;
      map.set(id, (map.get(id) || 0) + ((n.quantities?.[0]?.quantity) ?? 0));
    }
    page++;
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    await sleep(250);
  }
  console.log(`${label}: ${page} pages, ${map.size} products`);
  return map;
}

const COLL = `
  query($cursor: String) {
    collection(id: "${COLLECTION}") {
      products(first: 250, after: $cursor) {
        nodes {
          id title onlineStoreUrl
          featuredImage { url }
          priceRangeV2 { minVariantPrice { amount } }
          compareAtPriceRange { minVariantCompareAtPrice { amount } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

async function collectionProducts() {
  const out = [];
  let cursor = null, page = 0;
  while (true) {
    const d = await gql(COLL, { cursor });
    const conn = d.collection?.products;
    if (!conn) break;
    out.push(...conn.nodes);
    page++;
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    await sleep(250);
  }
  console.log(`collection: ${page} pages, ${out.length} products`);
  return out;
}

async function uploadAsset(value) {
  const res = await fetch(`https://${SHOP}/admin/api/${API}/themes/${THEME_ID}/assets.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ asset: { key: ASSET_KEY, value } }),
  });
  if (!res.ok) throw new Error(`Asset upload failed HTTP ${res.status}: ${await res.text()}`);
  console.log('Asset uploaded to live theme.');
}

(async () => {
  const stock = await qtyMap(YAS_STOCK, 'stock');
  const display = await qtyMap(YAS_DISPLAY, 'display');
  const products = await collectionProducts();

  const all = products.map(p => ({
    title:   p.title,
    url:     p.onlineStoreUrl || '',
    image:   p.featuredImage?.url || '',
    price:   p.priceRangeV2?.minVariantPrice?.amount || '',
    compare: p.compareAtPriceRange?.minVariantCompareAtPrice?.amount || '',
    qty:     (stock.get(p.id) || 0) + (display.get(p.id) || 0),
  }));

  const avail = all.filter(p => p.qty > 0).length;
  const out = 'window.YAS_CLEARANCE = ' + JSON.stringify(all) + ';';
  console.log(`${all.length} products (collection order), ${avail} in stock, ${all.length - avail} display sold-out, ${(out.length/1024).toFixed(0)} KB`);

  await uploadAsset(out);
  console.log('Done.');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
