import type { PublicConfig, Role, UserDto } from '@ritrovo/shared';
import { hasRole } from '@ritrovo/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { createApi, type Api } from './api';
import { getAccessToken } from './auth';

export interface Session {
  user: UserDto;
  config: PublicConfig;
  api: Api;
  can: (role: Role) => boolean;
  refreshUser: (u: UserDto) => void;
}

export const api = createApi(getAccessToken);

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ value, children }: { value: Omit<Session, 'api' | 'can'>; children: ReactNode }) {
  const session: Session = { ...value, api, can: (role) => hasRole(value.user.role, role) };
  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('Session not available');
  return s;
}
