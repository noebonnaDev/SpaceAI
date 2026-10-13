// Globals the server code expects from Node. Imported first by the demo entry point.
import { Buffer } from './shims/buffer';

const g = globalThis as unknown as { Buffer?: unknown; process?: { env: Record<string, string | undefined> } };
g.Buffer ??= Buffer;
g.process ??= { env: {} };
