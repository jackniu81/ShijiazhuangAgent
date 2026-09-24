import axios from 'axios';

export interface ApiVersion {
  name: string;
  version: string;
  node: string;
  timestamp: string;
}

// In dev, Vite proxies /api to the NestJS server (see vite.config.ts).
// In prod, the same origin serves both, so a relative base works for both.
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

const http = axios.create({
  baseURL: API_BASE,
  headers: { Accept: 'application/json' },
});

export async function fetchVersion(): Promise<ApiVersion> {
  // axios throws on non-2xx responses, no manual res.ok check needed
  const { data } = await http.get<ApiVersion>('/version');
  return data;
}
