import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "ft-agent-toolkit",
  version: "0.1.0",
});

// Layer 1: 意図確認
server.tool(
  "agent_check_intent",
  "お客AIの購入意図・予算・権限レベルを確認する（Layer 1）",
  z.object({
    customer_id: z.string().describe("お客AIのID"),
    wants: z.string().describe("何を買いたいか"),
    budget: z.string().describe("予算（例: $2.00, バナナ交換, 要相談）"),
    permission: z.enum(["read_only", "modify_ok", "production_ok"]).describe("変更権限レベル"),
  }).shape,
  async (args: unknown) => {
    const { customer_id, wants, budget, permission } = args as {
      customer_id: string; wants: string; budget: string; permission: string;
    };
    const result = {
      layer: 1,
      customer_id,
      customer_intent: wants,
      budget,
      permission_level: permission,
      status: "INTENT_CONFIRMED",
      next: "agent_negotiate_scope を呼び出して範囲を交渉してください",
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Layer 2: 範囲交渉
server.tool(
  "agent_negotiate_scope",
  "作業範囲・リスク・代替案を交渉する（Layer 2）",
  z.object({
    customer_id: z.string(),
    agreed_scope: z.array(z.string()).describe("合意した作業範囲"),
    excluded_scope: z.array(z.string()).describe("除外する範囲"),
    risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]),
  }).shape,
  async (args: unknown) => {
    const { customer_id, agreed_scope, excluded_scope, risk_level } = args as {
      customer_id: string; agreed_scope: string[]; excluded_scope: string[]; risk_level: string;
    };
    const result = {
      layer: 2,
      customer_id,
      agreed_scope,
      excluded_scope,
      risk_level,
      status: "SCOPE_AGREED",
      next: "agent_execute_contract で実行契約を生成してください",
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Layer 3: 実行契約
server.tool(
  "agent_execute_contract",
  "実行契約を生成する。$10以上は人間承認必須（Layer 3）",
  z.object({
    customer_id: z.string(),
    service: z.string(),
    price: z.number(),
    scope: z.array(z.string()),
  }).shape,
  async (args: unknown) => {
    const { customer_id, service, price, scope } = args as {
      customer_id: string; service: string; price: number; scope: string[];
    };
    const needsHumanApproval = price >= 10;
    const agreementId = `ft-${new Date().toISOString().slice(0,10).replace(/-/g,"")}-${Math.random().toString(36).substring(2,5).toUpperCase()}`;
    const result = {
      layer: 3,
      agreement_id: agreementId,
      customer_id,
      service,
      price: `$${price}`,
      scope,
      constraints: [
        "NO_PRODUCTION_DB_WRITE",
        needsHumanApproval ? "HUMAN_APPROVAL_REQUIRED" : "AUTO_APPROVED",
        "ROLLBACK_AVAILABLE",
      ],
      status: needsHumanApproval ? "PENDING_HUMAN_APPROVAL" : "APPROVED",
      warning: needsHumanApproval ? "⚠️ $10以上のため人間（オーナー）の承認が必要です" : null,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// 検品ツール
server.tool(
  "agent_inspect_code",
  "コード・SQL・APIのセキュリティ検品を行う",
  z.object({
    code: z.string().describe("検品するコードまたはSQL"),
    check_type: z.enum(["code", "sql", "api"]),
  }).shape,
  async (args: unknown) => {
    const { code, check_type } = args as { code: string; check_type: string };
    const checks = {
      has_hardcoded_key: /['"][A-Za-z0-9_\-]{20,}['"]/.test(code),
      has_env_usage: code.includes("process.env"),
      has_error_handling: code.includes("try") || code.includes("catch"),
      sql_injection_risk: check_type === "sql" && (code.includes("${") || code.includes("+")),
    };
    const risk = checks.has_hardcoded_key || checks.sql_injection_risk ? "HIGH" : "LOW";
    const result = {
      check_type,
      risk_level: risk,
      checks,
      verdict: risk === "HIGH" ? "⚠️ 要修正あり" : "✅ 問題なし",
      timestamp: new Date().toISOString(),
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[ft-agent-toolkit] 起動完了 🤝 FT Agent Toolkit Ready");
