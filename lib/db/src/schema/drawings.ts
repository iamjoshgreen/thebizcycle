import { pgTable, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

export const drawingsTable = pgTable("drawings", {
  id: integer("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Drawing = typeof drawingsTable.$inferSelect;
