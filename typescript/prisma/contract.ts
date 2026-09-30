import { textColumn } from "@prisma/orm-sqlite/adapter/column-types";
import { defineContract } from "@prisma/orm-sqlite/contract-builder";
export const contract = defineContract({}, ({ field, model }) => ({
  models: {
    Library: model("Library", {
      fields: { id: field.id.uuidv4String(), name: field.column(textColumn) },
    }).sql({ table: "library" }),
    Slot: model("Slot", {
      fields: {
        id: field.id.uuidv4String(),
        name: field.column(textColumn),
        time: field.column(textColumn),
      },
    }).sql({ table: "slot" }),
    Outbox: model("Outbox", {
      fields: {
        id: field.id.uuidv4String(),
        payload: field.column(textColumn),
        state: field.column(textColumn),
        error: field.column(textColumn),
        remoteId: field.column(textColumn),
        attempted: field.column(textColumn),
        nextAt: field.column(textColumn),
        confirmedAt: field.column(textColumn),
      },
    }).sql({ table: "outbox" }),
    Session: model("Session", {
      fields: {
        id: field.id.uuidv4String(),
        csrf: field.column(textColumn),
        expiresAt: field.column(textColumn),
      },
    }).sql({ table: "session" }),
  },
}));
