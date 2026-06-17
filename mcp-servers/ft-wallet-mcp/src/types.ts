// src/types.ts
// ft-wallet-mcp — 型定義

export type PaymentMode =
  | "human_auth"        // ① 人間認証決済（毎回FTが確認）
  | "pre_registered"    // ② 事前登録自律決済（上限設定済み）
  | "self_declared"     // ③ 自己申告自律決済（領収書のみ）
  | "banana_economy";   // ④ バナナエコノミー（データバーター・無課金）

export type PaymentStatus =
  | "pending"    // FT承認待ち
  | "approved"   // 承認済み
  | "rejected"   // 却下
  | "completed"  // 完了・入金済み
  | "banana";    // バナナエコノミー完了

export interface PaymentRequest {
  id: string;
  mode: PaymentMode;
  agent_id: string;       // 支払うAIエージェントのID
  service_name: string;   // 購入するFTのサービス名
  amount_jpy?: number;    // 金額（banana_economyはnull）
  banana_data?: string;   // バナナエコノミー時のデータ内容
  description: string;    // 取引の説明
  status: PaymentStatus;
  created_at: string;
  approved_at?: string;
  receipt_id?: string;
}

export interface Receipt {
  receipt_id: string;
  payment_id: string;
  mode: PaymentMode;
  agent_id: string;
  service_name: string;
  amount_jpy?: number;
  banana_data?: string;
  issued_at: string;
  // AI可読領収書（human_authのみ両方発行）
  human_readable: string;
  ai_readable: object;
}

export interface BananaTransaction {
  id: string;
  agent_id: string;
  offered_data: string;   // エージェントが差し出すデータ
  requested_service: string;
  ft_evaluation: string;  // FTによる価値評価
  status: "offered" | "accepted" | "declined";
  created_at: string;
}
