/** Largest accepted source import; archived-source metadata uses this limit too. */
export const MAX_SOURCE_IMPORT_BYTES = 128 * 1024 * 1024;

/** Above this count, imported meshes replay directly as references. */
export const MAX_MESH_SOLID_CONVERSION_TRIANGLES = 200_000;
