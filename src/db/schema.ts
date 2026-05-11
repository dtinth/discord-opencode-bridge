import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const channelConfigs = sqliteTable("channel_configs", {
  channelId: text("channel_id").primaryKey(),
  serverUrl: text("server_url").notNull(),
  password: text("password"),
  directory: text("directory").notNull(),
  createdAt: text("created_at").notNull().default("(current_timestamp)"),
});

export const threadSessions = sqliteTable("thread_sessions", {
  threadId: text("thread_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  sessionId: text("session_id").notNull(),
  lastSentMessageId: text("last_sent_message_id"),
  createdAt: text("created_at").notNull().default("(current_timestamp)"),
  updatedAt: text("updated_at").notNull().default("(current_timestamp)"),
});
