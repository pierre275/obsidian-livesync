import { describe, it, vi, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { genSetupUri } from "./genSetupUri";

describe("genSetupUri", () => {
    let tmpDir: string;
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-setup-uri-"));
        writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });

    afterEach(async () => {
        writeSpy.mockRestore();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("emits a setup URI to stdout when settings file is valid", async () => {
        const settingsPath = path.join(tmpDir, "settings.json");
        await fs.writeFile(
            settingsPath,
            JSON.stringify({
                couchDB_URI: "http://localhost:5984",
                couchDB_DBNAME: "livesync",
                couchDB_USER: "admin",
                couchDB_PASSWORD: "secret",
                passphrase: "vault-encryption-passphrase",
                isConfigured: true,
            })
        );

        await genSetupUri(settingsPath, "one-time-passphrase");

        expect(writeSpy).toHaveBeenCalledTimes(1);
        const written = String(writeSpy.mock.calls[0][0]);
        expect(written.startsWith("obsidian://setuplivesync?settings=")).toBe(true);
        expect(written.endsWith("\n")).toBe(true);
    });

    it("throws if the settings file is missing", async () => {
        const missing = path.join(tmpDir, "nope.json");
        await expect(genSetupUri(missing, "x")).rejects.toThrow(/ENOENT|not found|missing/i);
    });

    it("throws if passphrase is empty", async () => {
        const settingsPath = path.join(tmpDir, "settings.json");
        await fs.writeFile(settingsPath, JSON.stringify({ isConfigured: true }));
        await expect(genSetupUri(settingsPath, "")).rejects.toThrow(/passphrase/i);
    });
});
