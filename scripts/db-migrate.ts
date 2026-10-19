import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { getConfig } from "@/lib/config";
import { getNow } from "@/lib/time/now";

const applied = migrate(getDb(), getNow());
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date", `(${getConfig().databasePath})`);
closeDb();
