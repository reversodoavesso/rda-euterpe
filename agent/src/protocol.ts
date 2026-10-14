import { z } from "zod";

export const VERSION = "0.1.0";

export const MessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    secret: z.string(),
    appVersion: z.string(),
    locale: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool.result"),
    id: z.string(),
    ok: z.boolean(),
    data: z.unknown(),
    code: z.string().optional(),
  }),
  z.object({
    type: z.literal("chat.send"),
    text: z.string(),
    sessionId: z.string().optional(),
  }),
  z.object({
    type: z.literal("chat.clear"),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal("proposal.decision"),
    proposalId: z.string(),
    decision: z.enum(["approve", "reject"]),
  }),
  z.object({
    type: z.literal("event.songchange"),
    uri: z.string(),
  }),
  z.object({
    type: z.literal("ping"),
  }),
  z.object({
    type: z.literal("pong"),
  }),
  z.object({
    type: z.literal("client.debug"),
    level: z.enum(["log", "warn", "error"]).optional(),
    detail: z.string(),
  }),
]);

export type ClientMessage = z.infer<typeof MessageSchema>;

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ServerMessage =
  | { type: "hello.ok"; version: string }
  | { type: "pong" }
  | { type: "chat.status"; sessionId?: string; status: string; detail?: string }
  | { type: "chat.stream"; sessionId?: string; delta: string }
  | { type: "chat.done"; sessionId?: string; suggestions?: string[] }
  | { type: "chat.cleared"; sessionId: string }
  | { type: "tool.call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "proposal.create";
      proposalId: string;
      kind: string;
      title: string;
      name: string;
      args: Record<string, unknown>;
    };
