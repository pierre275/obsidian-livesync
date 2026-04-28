import { PouchDB } from "../lib/pouchdb-node";

interface RemoteCouchSettings {
    couchDB_URI: string;
    couchDB_DBNAME: string;
    couchDB_USER: string;
    couchDB_PASSWORD: string;
}

/**
 * Subscribe to a remote CouchDB changes feed and emit one line per change to stdout.
 *
 * Intentionally does NOT initialise the full LiveSync core or open the local
 * PouchDB — running this concurrently with `livesync-cli sync` would otherwise
 * deadlock on the local LevelDB lock. Reads settings directly from the JSON file.
 */
export async function runWatch(settings: RemoteCouchSettings): Promise<void> {
    const url = `${settings.couchDB_URI}/${settings.couchDB_DBNAME}`;

    const remoteDB = new PouchDB(url, {
        auth: {
            username: settings.couchDB_USER,
            password: settings.couchDB_PASSWORD,
        },
        skip_setup: true,
    });

    console.error(`[watch] subscribing to ${url}`);
    return new Promise<void>((_resolve, reject) => {
        const feed = remoteDB.changes({ live: true, since: "now", include_docs: false });
        feed.on("change", (change) => {
            process.stdout.write(change.id + "\n");
        });
        feed.on("error", (err) => {
            console.error("[watch] feed error:", err);
            reject(err instanceof Error ? err : new Error(String(err)));
        });
        feed.on("complete", (info) => {
            console.error("[watch] feed completed:", JSON.stringify(info));
            reject(new Error(`changes feed completed: ${JSON.stringify(info)}`));
        });
    });
}
