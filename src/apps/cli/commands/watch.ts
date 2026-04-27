import { PouchDB } from "../lib/pouchdb-node";
import type { CLICommandContext } from "./types";

export async function runWatch(context: CLICommandContext): Promise<void> {
    const { core } = context;
    await core.services.control.activated;

    const settings = core.getSettings();
    const url = `${settings.couchDB_URI}/${settings.couchDB_DBNAME}`;

    const remoteDB = new PouchDB(url, {
        auth: {
            username: settings.couchDB_USER,
            password: settings.couchDB_PASSWORD,
        },
        skip_setup: true,
    });

    return new Promise<void>((_resolve, reject) => {
        remoteDB
            .changes({ live: true, since: "now", include_docs: false })
            .on("change", (change) => {
                process.stdout.write(change.id + "\n");
            })
            .on("error", (err) => {
                console.error("[watch] Error:", err);
                reject(err);
            })
            .on("complete", (info) => {
                reject(new Error(`[watch] Changes feed completed unexpectedly: ${JSON.stringify(info)}`));
            });
    });
}
