// The MCP server: four read-only shop tools over invented data, plus ask_model.
// A fresh server is built per MCP request (stateless transport).
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { ModelError, MAX_MESSAGE } from './model.mjs';
import { STORES, searchProducts, getProduct, checkStock, getOrderStatus } from './catalogue.mjs';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** Names of the shop tools the demo agent may offer the model (ask_model is excluded). */
export const SHOP_TOOLS = ['search_products', 'get_product', 'check_stock', 'get_order_status'];

export function createMcpServer({ model }) {
  const server = new McpServer({ name: 'northlight-shop-mcp', version: '2.0.0' });

  server.registerTool('search_products', {
    description: 'Search the Northlight Cameras catalogue (fictional demo data). Returns up to 8 products with id, name, '
      + 'category, price in SEK, lens mount and total units in stock. Use plain keywords such as "travel", "mirrorless", '
      + '"portrait" or a brand.',
    inputSchema: z.object({
      query: z.string().max(200).optional().describe('Keywords, e.g. "mirrorless travel"'),
      category: z.enum(['camera', 'lens', 'accessory']).optional(),
      maxPriceSek: z.number().int().positive().max(1_000_000).optional().describe('Highest price in SEK'),
      mount: z.enum(['Lumora ZX', 'Kestrel K']).optional().describe('Only products for this lens mount'),
    }).strict(),
    annotations: readOnly,
  }, async (args) => json(searchProducts(args)));

  server.registerTool('get_product', {
    description: 'Full details for one product id, including specs and, for cameras, the lenses and accessories that fit it.',
    inputSchema: z.object({ productId: z.string().max(40) }).strict(),
    annotations: readOnly,
  }, async (args) => json(getProduct(args)));

  server.registerTool('check_stock', {
    description: `Units in stock for one product id, per store or for one store. Stores: ${STORES.join(', ')}.`,
    inputSchema: z.object({
      productId: z.string().max(40),
      store: z.string().max(40).optional().describe('One store name; omit for all stores'),
    }).strict(),
    annotations: readOnly,
  }, async (args) => json(checkStock(args)));

  server.registerTool('get_order_status', {
    description: 'Status, items and delivery detail for a demo order number such as NL-10482.',
    inputSchema: z.object({ orderNumber: z.string().max(20) }).strict(),
    annotations: readOnly,
  }, async (args) => json(getOrderStatus(args)));

  server.registerTool('ask_model', {
    description: 'Send one plain-text question (1-2000 characters) to the app\'s configured model and return its '
      + 'single-turn reply. No tools, no memory, nothing stored; the only I/O is the model call.',
    inputSchema: z.object({
      message: z.string().max(MAX_MESSAGE).refine((value) => value.trim().length > 0, 'message must not be blank'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ message }, extra) => {
    try {
      return { content: [{ type: 'text', text: await model.ask(message, extra?.signal) }] };
    } catch (error) {
      const code = error instanceof ModelError ? error.code : 'model_response_failed';
      return { isError: true, content: [{ type: 'text', text: code }] };
    }
  });

  return server;
}
