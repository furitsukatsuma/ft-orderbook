// src/index.ts
// ft-wallet-mcp — メインエントリーポイント

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWalletTools } from "./tools/wallet.js";
import { orderbookSchemas } from "./tools/orderbook-schemas.js";
import { getOrderbookBackend, type OrderbookHandlers } from "./backends/orderbook.js";

const server = new McpServer({
  name: "ft-wallet-mcp",
  version: "0.7.0",
});

registerWalletTools(server);

// 取引板ツールを登録。ハンドラ実体は env に応じた backend（supabase|sqlite）から差し込む。
const { backend, handlers } = await getOrderbookBackend();

for (const [name, def] of Object.entries(orderbookSchemas)) {
  const handler = handlers[def.handler as keyof OrderbookHandlers] as (args: unknown) => Promise<unknown>;
  server.tool(name, def.description, def.schema.shape, async (args: unknown) => {
    const result = await handler(args as never);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[ft-wallet-mcp] 起動完了 🏪 FT AI Convenience Store Wallet Ready (orderbook backend: ${backend})`);
