import { describe, it, vi, expect, beforeEach, afterEach } from "vitest";

vi.mock("../lib/pouchdb-node", () => {
    const mockOn = vi.fn();
    const mockChanges = vi.fn();
    mockOn.mockReturnValue({ on: mockOn });
    mockChanges.mockReturnValue({ on: mockOn });
    const MockPouchDB = vi.fn().mockImplementation(function () { return { changes: mockChanges }; });
    return { PouchDB: MockPouchDB };
});

import { PouchDB } from "../lib/pouchdb-node";
import { runWatch } from "./watch";

function makeSettings() {
    return {
        couchDB_URI: "http://localhost:5984",
        couchDB_DBNAME: "testdb",
        couchDB_USER: "admin",
        couchDB_PASSWORD: "secret",
    };
}

describe("runWatch", () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });

    afterEach(() => {
        writeSpy.mockRestore();
    });

    it("creates remote PouchDB with correct URL and auth", async () => {
        runWatch(makeSettings());
        await Promise.resolve(); // flush microtasks

        expect(PouchDB).toHaveBeenCalledWith(
            "http://localhost:5984/testdb",
            expect.objectContaining({
                auth: { username: "admin", password: "secret" },
                skip_setup: true,
            })
        );
    });

    it("subscribes to live changes since now", async () => {
        const { PouchDB: MockPouchDB } = await import("../lib/pouchdb-node");
        const mockInstance = { changes: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis() }) };
        (MockPouchDB as any).mockImplementationOnce(function () { return mockInstance; });

        runWatch(makeSettings());
        await Promise.resolve();

        expect(mockInstance.changes).toHaveBeenCalledWith(
            expect.objectContaining({ live: true, since: "now", include_docs: false })
        );
    });

    it("writes change id to stdout on change event", async () => {
        let capturedChangeHandler: ((c: any) => void) | undefined;
        const { PouchDB: MockPouchDB } = await import("../lib/pouchdb-node");

        const mockOn = vi.fn((event: string, handler: (c: any) => void) => {
            if (event === "change") capturedChangeHandler = handler;
            return { on: mockOn };
        });
        (MockPouchDB as any).mockImplementationOnce(function () {
            return { changes: vi.fn().mockReturnValue({ on: mockOn }) };
        });

        runWatch(makeSettings());
        await Promise.resolve();

        capturedChangeHandler?.({ id: "notes/hello.md" });
        expect(writeSpy).toHaveBeenCalledWith("notes/hello.md\n");
    });

    it("rejects when changes feed emits error", async () => {
        let capturedErrorHandler: ((err: any) => void) | undefined;
        const { PouchDB: MockPouchDB } = await import("../lib/pouchdb-node");

        const mockOn = vi.fn((event: string, handler: (c: any) => void) => {
            if (event === "error") capturedErrorHandler = handler;
            return { on: mockOn };
        });
        (MockPouchDB as any).mockImplementationOnce(function () {
            return { changes: vi.fn().mockReturnValue({ on: mockOn }) };
        });

        const watchPromise = runWatch(makeSettings());
        await Promise.resolve();

        capturedErrorHandler?.(new Error("connection reset"));
        await expect(watchPromise).rejects.toThrow("connection reset");
    });
});
