// HTTP API のみ起動（3099）。LaunchAgent / 手動起動用。
// Claude Desktop の MCP（stdio）は dist/index.js のみ使用し、ポート競合を避ける。
import "dotenv/config";
import { startHttpServer } from "./http-server.js";

startHttpServer();
console.error("[ft-wallet-mcp] HTTP API のみ起動（orderbook.ftai.uk 用）");
