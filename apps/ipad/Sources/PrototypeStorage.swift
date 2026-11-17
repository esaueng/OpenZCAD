import Foundation

/// Copies an earlier unshipped prototype's origin without deleting or editing
/// its IndexedDB records. Unsupported structured-clone values fail closed.
enum PrototypeStorage {
    static let legacyOrigin = URL(string: "http://127.0.0.1:27183")!
    static let marker = "zcad-ipad-private-storage-v1"
    static let testStore = UUID(uuidString: "0B81A7BF-40D9-413D-8D2B-16C2DD3F0B8E")!

    static let collect = #"""
    const bytes = value => {
        let text = '';
        for (let i = 0; i < value.length; i += 32768) text += String.fromCharCode(...value.subarray(i, i + 32768));
        return btoa(text);
    };
    async function encode(value, ancestors = new Set()) {
        if (value === undefined) return {t: 'undefined'};
        if (typeof value === 'bigint') return {t: 'bigint', v: String(value)};
        if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return {t: 'number', v: Object.is(value, -0) ? '-0' : String(value)};
        if (value === null || typeof value !== 'object') return value;
        if (ancestors.has(value)) throw new Error('A recovery record has a cyclic value. Original data was not changed.');
        const active = new Set(ancestors); active.add(value);
        try {
            if (value instanceof ArrayBuffer) return {t: 'buffer', v: bytes(new Uint8Array(value))};
            if (ArrayBuffer.isView(value)) return {t: 'view', c: value.constructor.name, offset: value.byteOffset, length: value instanceof DataView ? value.byteLength : value.length, v: bytes(new Uint8Array(value.buffer))};
            if (value instanceof File) return {t: 'file', name: value.name, modified: value.lastModified, type: value.type, v: bytes(new Uint8Array(await value.arrayBuffer()))};
            if (value instanceof Blob) return {t: 'blob', type: value.type, v: bytes(new Uint8Array(await value.arrayBuffer()))};
            if (value instanceof Date) return {t: 'date', v: value.toISOString()};
            if (Array.isArray(value)) return {t: 'array', v: await Promise.all(value.map(child => encode(child, active)))};
            if (value instanceof Map) return {t: 'map', v: await Promise.all([...value].map(async ([k,v]) => [await encode(k, active), await encode(v, active)]))};
            if (value instanceof Set) return {t: 'set', v: await Promise.all([...value].map(child => encode(child, active)))};
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('An earlier prototype record needs manual recovery. Original data was not changed.');
            return {t: 'object', v: await Promise.all(Object.entries(value).map(async ([k,v]) => [k, await encode(v, active)]))};
        } finally { active.delete(value); }
    }
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const snapshot = {local: Object.entries(localStorage), databases: []};
    for (const info of await indexedDB.databases()) {
        const db = await request(indexedDB.open(info.name));
        try {
            const stores = [];
            for (const name of db.objectStoreNames) {
                const store = db.transaction(name).objectStore(name);
                const keys = request(store.getAllKeys()), values = request(store.getAll());
                const definition = {name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [...store.indexNames].map(name => {
                    const index = store.index(name); return {name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry};
                })};
                const [k, v] = await Promise.all([keys, values]);
                definition.records = await Promise.all(k.map(async (key, i) => [await encode(key), await encode(v[i])]));
                stores.push(definition);
            }
            snapshot.databases.push({name: db.name, version: db.version, stores});
        } finally { db.close(); }
    }
    const json = JSON.stringify(snapshot);
    if (new Blob([json]).size > 64 * 1024 * 1024) throw new Error('Earlier prototype data exceeds the automatic recovery limit. Original data was not changed.');
    return json;
    """#

    static let restore = #"""
    const marker = 'zcad-ipad-private-storage-v1';
    if (localStorage.getItem(marker) === 'complete') return;
    if (!localStorage.getItem(marker) && (await indexedDB.databases()).length) throw new Error('Existing private workspace data was left unchanged.');
    localStorage.setItem(marker, 'copying');
    const data = JSON.parse(snapshot);
    const buffer = text => Uint8Array.from(atob(text), c => c.charCodeAt(0)).buffer;
    function decode(value) {
        if (value === null || typeof value !== 'object') return value;
        switch (value.t) {
        case 'undefined': return undefined;
        case 'bigint': return BigInt(value.v);
        case 'number': return Number(value.v);
        case 'buffer': return buffer(value.v);
        case 'view': {
            const constructors = {DataView, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array};
            if (!Object.hasOwn(constructors, value.c)) throw new Error('Unsupported stored array.');
            return new constructors[value.c](buffer(value.v), value.offset, value.length);
        }
        case 'file': return new File([buffer(value.v)], value.name, {type: value.type, lastModified: value.modified});
        case 'blob': return new Blob([buffer(value.v)], {type: value.type});
        case 'date': return new Date(value.v);
        case 'array': return value.v.map(decode);
        case 'map': return new Map(value.v.map(([k,v]) => [decode(k), decode(v)]));
        case 'set': return new Set(value.v.map(decode));
        case 'object': return Object.fromEntries(value.v.map(([k,v]) => [k, decode(v)]));
        default: throw new Error('Unsupported recovery record.');
        }
    }
    for (const source of data.databases) {
        const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open(source.name, source.version);
            open.onupgradeneeded = () => {
                for (const definition of source.stores) {
                    const store = open.result.createObjectStore(definition.name, {keyPath: definition.keyPath, autoIncrement: definition.autoIncrement});
                    for (const index of definition.indexes) store.createIndex(index.name, index.keyPath, {unique: index.unique, multiEntry: index.multiEntry});
                }
            };
            open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
            open.onblocked = () => reject(new Error('Recovery storage is busy.'));
        });
        try {
            if (source.stores.length) await new Promise((resolve, reject) => {
                const tx = db.transaction(source.stores.map(s => s.name), 'readwrite');
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
                for (const definition of source.stores) {
                    const store = tx.objectStore(definition.name);
                    store.clear();
                    for (const [key, value] of definition.records) {
                        if (definition.keyPath === null) store.put(decode(value), decode(key));
                        else store.put(decode(value));
                    }
                }
            });
        } finally { db.close(); }
    }
    for (const [key, value] of data.local) if (key !== marker) localStorage.setItem(key, value);
    localStorage.setItem(marker, 'complete');
    """#
}
