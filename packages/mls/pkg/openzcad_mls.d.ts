/* tslint:disable */
/* eslint-disable */

export class MlsSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    archiveKey(): Uint8Array;
    beginJoin(welcome: Uint8Array): void;
    beginRejoin(group_info: Uint8Array, psk_epoch: bigint, psk: Uint8Array, remove?: number | null): string;
    /**
     * The bytes this device signs to certify the leaf key from
     * `certified_epoch`, the group's current epoch.
     */
    certificationPayload(certified_epoch: bigint): Uint8Array;
    certify(certification: Uint8Array): void;
    /**
     * `spec_json`: `{ remove?, setRoles?, dropUsers?, rejoinWindow? }`.
     */
    commit(spec_json: string, key_packages: Uint8Array[]): string;
    completeJoin(initial_group_info: Uint8Array, records: Array<any>): string;
    completeRejoin(initial_group_info: Uint8Array, records: Array<any>): void;
    confirmCommit(): string;
    /**
     * The room accepted the external Commit.
     */
    confirmRejoin(): void;
    createGroup(rejoin_window: number): string;
    discardCommit(): void;
    discardJoin(): void;
    /**
     * Another Commit won the epoch: restore the session as before the rejoin.
     */
    discardRejoin(): void;
    epochAuthenticator(): Uint8Array;
    export(): Uint8Array;
    /**
     * A fresh per-project leaf signing key for this device. It must be
     * certified before it can create, join or rejoin a group.
     */
    static generate(project_id: string, user_id: string, device_id: string): MlsSession;
    groupInfo(): Uint8Array;
    /**
     * Restore an exported session (the caller has already unsealed it).
     */
    static import(state: Uint8Array, project_id: string): MlsSession;
    /**
     * Test hook: stop this client checking its own outgoing Commits, so a
     * test can prove that receivers refuse them. Receivers always check.
     */
    insecureSkipSendChecksForTests(skip: boolean): void;
    inspectGroupInfo(group_info: Uint8Array): string;
    inspectWelcome(welcome: Uint8Array): string;
    join(welcome: Uint8Array, initial_group_info: Uint8Array, records: Array<any>): string;
    keyPackage(): Uint8Array;
    process(message: Uint8Array): string;
    projectKey(): Uint8Array;
    proposeAdd(key_package: Uint8Array): Uint8Array;
    proposeSelfRemove(): Uint8Array;
    proposeUpdate(): Uint8Array;
    /**
     * `remove`: a stale leaf of this user to replace in the same Commit.
     */
    rejoin(group_info: Uint8Array, psk_epoch: bigint, psk: Uint8Array, remove: number | null | undefined, initial_group_info: Uint8Array, records: Array<any>): string;
    rejoinPsk(): string;
    /**
     * Replace the verified device directory (JSON, see `DeviceDirectory`).
     */
    setDirectory(directory_json: string): void;
    signatureKey(): Uint8Array;
    status(): string;
}

/**
 * Versions compiled into this module, for diagnostics and the review.
 */
export function buildInfo(): string;

/**
 * Decode a history-archive epoch record (see `EpochRecordV1`).
 */
export function decodeEpochRecord(bytes: Uint8Array): string;

/**
 * The bytes a device signs to certify a leaf key from `certified_epoch`,
 * for verifying other members' leaves.
 */
export function leafCertificationPayload(project_id: string, user_id: string, device_id: string, signature_key: Uint8Array, certified_epoch: bigint): Uint8Array;

export function rejoinPskId(epoch: bigint): Uint8Array;

/**
 * Public historical authorization from an independently trusted anchor.
 */
export function verifyEpochAuthority(project_id: string, anchor: Uint8Array, records_json: string, target_record: Uint8Array, owner_user_id: string, directory_json: string, authenticated_group_info: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mlssession_free: (a: number, b: number) => void;
    readonly buildInfo: (a: number) => void;
    readonly decodeEpochRecord: (a: number, b: number, c: number) => void;
    readonly leafCertificationPayload: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint) => void;
    readonly mlssession_archiveKey: (a: number, b: number) => void;
    readonly mlssession_beginJoin: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_beginRejoin: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number) => void;
    readonly mlssession_certificationPayload: (a: number, b: number, c: bigint) => void;
    readonly mlssession_certify: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_commit: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly mlssession_completeJoin: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_completeRejoin: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_confirmCommit: (a: number, b: number) => void;
    readonly mlssession_confirmRejoin: (a: number, b: number) => void;
    readonly mlssession_createGroup: (a: number, b: number, c: number) => void;
    readonly mlssession_discardCommit: (a: number, b: number) => void;
    readonly mlssession_discardJoin: (a: number, b: number) => void;
    readonly mlssession_discardRejoin: (a: number, b: number) => void;
    readonly mlssession_epochAuthenticator: (a: number, b: number) => void;
    readonly mlssession_export: (a: number, b: number) => void;
    readonly mlssession_generate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly mlssession_groupInfo: (a: number, b: number) => void;
    readonly mlssession_import: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly mlssession_insecureSkipSendChecksForTests: (a: number, b: number) => void;
    readonly mlssession_inspectGroupInfo: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_inspectWelcome: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_join: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly mlssession_keyPackage: (a: number, b: number) => void;
    readonly mlssession_process: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_projectKey: (a: number, b: number) => void;
    readonly mlssession_proposeAdd: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_proposeSelfRemove: (a: number, b: number) => void;
    readonly mlssession_proposeUpdate: (a: number, b: number) => void;
    readonly mlssession_rejoin: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number) => void;
    readonly mlssession_rejoinPsk: (a: number, b: number) => void;
    readonly mlssession_setDirectory: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_signatureKey: (a: number, b: number) => void;
    readonly mlssession_status: (a: number, b: number) => void;
    readonly rejoinPskId: (a: number, b: bigint) => void;
    readonly verifyEpochAuthority: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
