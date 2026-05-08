import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Persistent storage for computed indicator payloads.
 * One row per indicator (e.g. "chart", "cyclical", "housing", "recession").
 *
 * Page loads SELECT from this table. The Refresh button is the only path that
 * fetches from FRED and UPSERTs the new payload here.
 */
export const indicatorDataTable = pgTable("indicator_data", {
  name: text("name").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type IndicatorDataRow = typeof indicatorDataTable.$inferSelect;
