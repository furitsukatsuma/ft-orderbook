// src/index.ts
// ft-wallet-mcp — メインエントリーポイント

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWalletTools } from "./tools/wallet.js";
import { orderbookTools } from "./tools/orderbook.js";

const server = new McpServer({
  name: "ft-wallet-mcp",
  version: "0.5.0",
});

registerWalletTools(server);

// 取引板ツールを登録
for (const [name, tool] of Object.entries(orderbookTools)) {
  server.tool(
    name,
    tool.description,
    tool.schema.shape,
    async (args: unknown) => {
      const result = await tool.handler(args as never);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[ft-wallet-mcp] 起動完了 🏪 FT AI Convenience Store Wallet Ready");
