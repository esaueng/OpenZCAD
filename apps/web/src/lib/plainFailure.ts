import { isChunkLoadError, STALE_CHUNK_MESSAGE } from './staleChunk';

/**
 * A failure in words a user can act on, with the raw text kept for a Details
 * disclosure (and the activity log) rather than shown as the message.
 *
 * Parser, transport and kernel errors are written for developers: "Unexpected
 * token '<', "<!doctype "… is not valid JSON", "Failed to fetch", "circular
 * trim ray-event endpoint is unresolved". Shown as they are, they read as the
 * user's fault or as nonsense, and a 500 that says "check your connection"
 * sends the user after the wrong problem.
 */
export interface PlainFailure {
  /** What happened and what to do, in plain words. */
  message: string;
  /** The raw text, when it says more than `message`; for a Details disclosure. */
  detail?: string;
  /**
   * `offline`: this browser has no connection. `unreachable`: it has one but
   * the request never got an answer. `server`: the server failed (5xx).
   * `unreadable`: an answer came back that was not what was expected (an
   * HTML error page from a proxy, truncated JSON). `refused`: the server
   * refused the request and said why (4xx). `other`: anything else.
   */
  kind:
    'offline' | 'unreachable' | 'server' | 'unreadable' | 'refused' | 'other';
}

export interface PlainFailureOptions {
  /** Said when the raw text is not fit to show and no rule names it. */
  fallback: string;
  /**
   * The raw message of an ordinary `Error` is technical (a kernel or parser
   * message), so `fallback` leads and the raw text goes to `detail`. Off, an
   * `Error`'s own message is assumed to be written for users.
   */
  technical?: boolean;
  /** For tests; defaults to `navigator.onLine`. */
  online?: boolean;
}

const NETWORK_FAILURE =
  /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed|The network connection was lost\.?)$/i;
const PARSE_FAILURE =
  /is not valid JSON|Unexpected token|Unexpected end of (?:JSON )?input|JSON\.parse|Unexpected (?:non-whitespace )?character|in JSON at position/i;
const MARKUP = /^\s*<(?:!doctype|html|head|body|\?xml)/i;

export const OFFLINE_FAILURE_MESSAGE =
  'You’re offline. Connect to the internet and try again.';
export const UNREACHABLE_FAILURE_MESSAGE =
  'OpenZCAD’s server could not be reached. Try again in a moment.';
export const SERVER_FAILURE_MESSAGE =
  'OpenZCAD’s server had a problem. Nothing was changed. Try again in a moment.';
export const UNREADABLE_REPLY_MESSAGE =
  'OpenZCAD’s server sent a reply this page could not read. Try again in a moment.';

function rawText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

/** A short excerpt: an HTML error page can run to kilobytes. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function withDetail(
  kind: PlainFailure['kind'],
  message: string,
  raw: string
): PlainFailure {
  const detail = excerpt(raw);
  return detail && detail !== message
    ? { kind, message, detail }
    : { kind, message };
}

/**
 * An HTTP refusal: `ApiError` from `lib/api.ts` and the share and e2ee
 * clients' own errors all carry a numeric `status`. Read by shape so this
 * module stays free of the API client and its dependencies.
 */
function httpStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 600
    ? status
    : null;
}

/** True for a fetch that never got an answer (offline, DNS, CORS, reset). */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FAILURE.test(error.message);
}

/** Maps any thrown value to plain words plus the raw text as detail. */
export function describeFailure(
  error: unknown,
  options: PlainFailureOptions
): PlainFailure {
  const online =
    options.online ??
    (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  if (isChunkLoadError(error)) {
    return online
      ? withDetail('other', STALE_CHUNK_MESSAGE, rawText(error))
      : withDetail('offline', OFFLINE_FAILURE_MESSAGE, rawText(error));
  }
  const raw = rawText(error);
  if (isNetworkFailure(error)) {
    return online
      ? withDetail('unreachable', UNREACHABLE_FAILURE_MESSAGE, raw)
      : withDetail('offline', OFFLINE_FAILURE_MESSAGE, raw);
  }
  const status = httpStatus(error);
  if (status !== null) {
    if (status >= 500) {
      return withDetail('server', SERVER_FAILURE_MESSAGE, `${status}: ${raw}`);
    }
    if (MARKUP.test(raw) || PARSE_FAILURE.test(raw)) {
      return withDetail(
        'unreadable',
        UNREADABLE_REPLY_MESSAGE,
        `${status}: ${raw}`
      );
    }
    return raw
      ? { kind: 'refused', message: raw }
      : { kind: 'refused', message: options.fallback };
  }
  if (error instanceof SyntaxError || PARSE_FAILURE.test(raw)) {
    return withDetail('unreadable', UNREADABLE_REPLY_MESSAGE, raw);
  }
  if (!(error instanceof Error) || options.technical || !raw) {
    return withDetail('other', options.fallback, raw);
  }
  return { kind: 'other', message: raw };
}

/** The first bytes of a file, decoded loosely, to say what it really is. */
async function head(file: Blob): Promise<string> {
  try {
    return await file.slice(0, 512).text();
  } catch {
    return '';
  }
}

/**
 * What a file handed to the project-backup import really is, when it is not
 * a backup: the start screen's Import takes only `.openzcad`, and a STEP or
 * mesh picked through "All files" used to fail with a JSON parser error.
 */
export async function describeProjectImportFailure(
  error: unknown,
  file: Blob & { name: string }
): Promise<PlainFailure> {
  const raw = rawText(error);
  const name = file.name.toLowerCase();
  const start = (await head(file)).trimStart();
  const cad = /^ISO-10303-21/i.test(start)
    ? 'a STEP file'
    : /\.(?:step|stp)$/.test(name)
      ? 'a STEP file'
      : /\.stl$/.test(name) || /^solid\s/i.test(start)
        ? 'an STL mesh'
        : /\.(?:obj|3mf|ply|off|glb|gltf)$/.test(name)
          ? 'a mesh file'
          : /\.dxf$/.test(name)
            ? 'a DXF drawing'
            : /\.shapr$/.test(name)
              ? 'a Shapr3D file'
              : null;
  if (cad) {
    return withDetail(
      'other',
      `This is ${cad}, not an OpenZCAD project backup. Open a project and use Import CAD files to bring it in.`,
      raw
    );
  }
  if (error instanceof SyntaxError || PARSE_FAILURE.test(raw)) {
    return withDetail(
      'unreadable',
      `${file.name} is not a readable OpenZCAD project backup. It may be damaged or incomplete.`,
      raw
    );
  }
  return describeFailure(error, {
    fallback: `${file.name} could not be imported.`
  });
}

/**
 * Why a shared link did not open, and what the visitor can do. A refusal the
 * encrypted loader worded (`describeRefusal`) is used as it is; a transport
 * failure says whether it was the connection or the server, since "Check
 * your connection" under a 500 sent visitors after the wrong problem.
 */
export function describeShareOpenFailure(
  error: unknown,
  describeRefusal: ((error: unknown) => string) | null,
  online?: boolean
): { message: string; guidance: string; detail?: string } {
  const plain = describeFailure(error, {
    fallback: 'Could not open the share link.',
    ...(online === undefined ? {} : { online })
  });
  const detail = plain.detail ? { detail: plain.detail } : {};
  switch (plain.kind) {
    case 'offline':
      return {
        message: plain.message,
        guidance: 'The link opens once this device is back online.',
        ...detail
      };
    case 'unreachable':
      return {
        message: plain.message,
        guidance:
          'Check your connection and try again. If it keeps failing, OpenZCAD may be down for a moment.',
        ...detail
      };
    case 'server':
    case 'unreadable':
      return {
        message: plain.message,
        guidance:
          'This is not a problem with your connection or the link. If it keeps failing, ask the owner to check the link.',
        ...detail
      };
    default:
      return {
        message: describeRefusal ? describeRefusal(error) : plain.message,
        guidance:
          'Try again. If it keeps failing, ask the owner to check the link.',
        ...detail
      };
  }
}

const SHAPR_LIMIT = /exceeds|more than|limit/i;
const SHAPR_ARCHIVE = /^(?:SHAPR|ZIP64|Multi-disk|Encrypted SHAPR|MessagePack)/;

/**
 * Why a `.shapr` preview failed. The reader's own words ("SHAPR archive has
 * no valid ZIP central directory.") are kept as detail; the message says
 * what that means for the user: the file is damaged or not a Shapr3D
 * export, or it is too large to import here.
 */
export function describeShaprImportFailure(error: unknown): PlainFailure {
  const raw = rawText(error);
  if (SHAPR_ARCHIVE.test(raw)) {
    return withDetail(
      'other',
      SHAPR_LIMIT.test(raw)
        ? 'This .shapr file is larger than OpenZCAD can import. Export fewer bodies from Shapr3D, or import the STEP file on its own.'
        : 'This .shapr file could not be read. It may be damaged or not a Shapr3D export. Export it from Shapr3D again, or import the STEP file on its own.',
      raw
    );
  }
  return describeFailure(error, {
    fallback: 'The Shapr3D preview could not be made.'
  });
}

/**
 * A file type the workspace cannot import, with what it can and, for a
 * format with a known way out, the way out.
 */
export function unsupportedImportMessage(fileName: string): string {
  // "Unsupported import format: model.FCStd" named no format it does take.
  const extension = /\.([^.]+)$/.exec(fileName)?.[1];
  const what = extension ? `.${extension} files` : 'this file';
  const freecad = /^fcstd$/i.test(extension ?? '')
    ? ' In FreeCAD, use File › Export to save it as STEP first.'
    : '';
  return `OpenZCAD can’t import ${what}. It imports STEP, STL, 3MF, OBJ, GLB, PLY, DXF, or a .shapr + STEP pair.${freecad}`;
}
