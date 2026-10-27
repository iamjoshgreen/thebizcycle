import { pgTable, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** Per-user chart drawings. One row per user. */
export const drawingsTable = pgTable("drawings", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Drawing = typeof drawingsTable.$inferSelect;
