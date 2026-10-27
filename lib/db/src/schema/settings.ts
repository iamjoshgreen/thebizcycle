import { pgTable, text, jsonb, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** Per-user UI settings, keyed by (user_id, key). */
export const settingsTable = pgTable(
  "settings",
  {
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export type Setting = typeof settingsTable.$inferSelect;
