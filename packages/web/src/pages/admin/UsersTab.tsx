import type { Role, UserDto } from '@ritrovo/shared';
import { ErrorBox, Spinner, useAsync, useToast } from '../../components/ui';
import { fmtDateTime } from '../../format';
import { t } from '../../i18n';
import { useSession } from '../../session';

type AdminUser = UserDto & { isActive: boolean; lastLoginAt: string | null };

export function UsersTab() {
  const { api, user } = useSession();
  const toast = useToast();
  const users = useAsync(() => api.get<AdminUser[]>('/api/admin/users'), []);
  const update = async (u: AdminUser, patch: { role?: Role; isActive?: boolean }) => {
    try {
      await api.patch(`/api/admin/users/${u.id}`, patch);
      toast(t('admin.users.saved'));
      users.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="small muted">{t('admin.users.entraHint')}</p>
      <ErrorBox error={users.error} onRetry={users.reload} />
      {users.loading && !users.data && <Spinner />}
      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('admin.users.name')}</th>
              <th>{t('admin.users.email')}</th>
              <th>{t('admin.users.role')}</th>
              <th>{t('admin.users.active')}</th>
              <th>{t('admin.users.lastLogin')}</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td className="small">{u.email}</td>
                <td>
                  <select value={u.role} disabled={u.id === user.id} onChange={(e) => void update(u, { role: e.target.value as Role })} style={{ width: 'auto' }}>
                    {(['utente', 'reception', 'amministratore'] as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {t(`roles.${r}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="checkbox" checked={u.isActive} disabled={u.id === user.id} onChange={(e) => void update(u, { isActive: e.target.checked })} aria-label={t('admin.users.active')} />
                </td>
                <td className="small">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
