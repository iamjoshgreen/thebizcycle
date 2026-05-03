import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const cacheTable = pgTable("cache", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CacheRow = typeof cacheTable.$inferSelect;
