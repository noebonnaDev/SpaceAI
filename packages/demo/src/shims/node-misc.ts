// Stand-ins for Node modules the browser demo never calls at run time (files, network, MSAL for Node, pg).
const unavailable = (what: string) => () => {
  throw new Error(`${what} non è disponibile nella demo nel browser.`);
};

export const readFileSync = unavailable('Il file system');
export const existsSync = () => false;
export const readFile = unavailable('Il file system');
export const readdir = unavailable('Il file system');
export const fileURLToPath = (u: string | URL) => String(u);

const join = (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
export const path = {
  join,
  resolve: join,
  dirname: (p: string) => p.replace(/\/[^/]*$/, '') || '/',
  basename: (p: string) => p.replace(/^.*\//, ''),
  extname: (p: string) => (/\.[^./]*$/.exec(p)?.[0] ?? ''),
  sep: '/',
};

export class Pool {
  constructor() {
    throw new Error('PostgreSQL di rete non è disponibile nella demo: si usa il database nel browser.');
  }
}
export class ConfidentialClientApplication {
  constructor() {
    throw new Error('Microsoft Graph reale non è disponibile nella demo.');
  }
}

export default { readFileSync, existsSync, readFile, readdir, fileURLToPath, Pool, ConfidentialClientApplication, ...path, types: { setTypeParser() {} } };
