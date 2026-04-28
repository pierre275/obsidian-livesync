import * as fs from "fs/promises";
import { encodeSettingsToSetupURI } from "@lib/API/processSetting";

export async function genSetupUri(settingsPath: string, passphrase: string): Promise<void> {
    if (!passphrase) {
        throw new Error("passphrase must be a non-empty string");
    }
    const raw = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    const uri = await encodeSettingsToSetupURI(settings, passphrase, [], false);
    process.stdout.write(uri + "\n");
}
