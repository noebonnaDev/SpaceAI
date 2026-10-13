import type { Role, UserDto } from '@ritrovo/shared';
import { ROLE_RANK } from '@ritrovo/shared';
import type { Queryable } from '../db/db.js';

export interface UserRow {
  id: string;
  entra_oid: string | null;
  email: string;
  display_name: string;
  department: string | null;
  job_title: string | null;
  role: Role;
  hide_from_colleagues: boolean;
  is_active: boolean;
  last_login_at: Date | null;
}

export function userDto(u: UserRow, effectiveRole?: Role): UserDto {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    department: u.department,
    role: effectiveRole ?? u.role,
    hideFromColleagues: u.hide_from_colleagues,
  };
}

export function maxRole(a: Role, b: Role): Role {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export async function getUserById(q: Queryable, id: string): Promise<UserRow | null> {
  return (await q.query<UserRow>('select * from app_user where id = $1', [id])).rows[0] ?? null;
}

export async function getUserByEmail(q: Queryable, email: string): Promise<UserRow | null> {
  return (await q.query<UserRow>('select * from app_user where lower(email) = lower($1)', [email])).rows[0] ?? null;
}

/** Creates or refreshes the user from the identity claims of a validated token. */
export async function upsertUserFromIdentity(
  q: Queryable,
  identity: { oid: string | null; email: string; name: string },
  initialAdmins: string[],
): Promise<UserRow> {
  const email = identity.email.toLowerCase();
  let user: UserRow | null = null;
  if (identity.oid) {
    user = (await q.query<UserRow>('select * from app_user where entra_oid = $1', [identity.oid])).rows[0] ?? null;
  }
  user ??= await getUserByEmail(q, email);
  if (!user) {
    const role: Role = initialAdmins.includes(email) ? 'amministratore' : 'utente';
    user = (
      await q.query<UserRow>(
        `insert into app_user(entra_oid, email, display_name, role, last_login_at) values ($1, $2, $3, $4, now()) returning *`,
        [identity.oid, email, identity.name || email, role],
      )
    ).rows[0]!;
    return user;
  }
  const role: Role = initialAdmins.includes(email) ? maxRole(user.role, 'amministratore') : user.role;
  return (
    await q.query<UserRow>(
      `update app_user set entra_oid = coalesce($2, entra_oid), email = $3, display_name = $4, role = $5, last_login_at = now()
       where id = $1 returning *`,
      [user.id, identity.oid, email, identity.name || user.display_name, role],
    )
  ).rows[0]!;
}

/** Makes sure a colleague picked in the people picker exists locally (booking "per conto di"). */
export async function ensureUserByEmail(q: Queryable, email: string, name?: string, department?: string | null): Promise<UserRow> {
  const existing = await getUserByEmail(q, email);
  if (existing) return existing;
  return (
    await q.query<UserRow>(`insert into app_user(email, display_name, department) values ($1, $2, $3) returning *`, [
      email.toLowerCase(),
      name || email,
      department ?? null,
    ])
  ).rows[0]!;
}

export async function searchLocalUsers(q: Queryable, text: string, limit = 10): Promise<UserRow[]> {
  const like = `%${text.toLowerCase()}%`;
  return (
    await q.query<UserRow>(
      `select * from app_user where is_active and (lower(display_name) like $1 or lower(email) like $1) order by display_name limit $2`,
      [like, limit],
    )
  ).rows;
}
