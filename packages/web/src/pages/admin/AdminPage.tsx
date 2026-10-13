import { NavLink, Route, Routes } from 'react-router';
import { t } from '../../i18n';
import { AuditTab, SyncTab } from './SyncTab';
import { BuildingsTab } from './BuildingsTab';
import { KiosksTab } from './KiosksTab';
import { OverviewTab } from './OverviewTab';
import { ReportsTab } from './ReportsTab';
import { ResourcesTab } from './ResourcesTab';
import { SettingsTab } from './SettingsTab';
import { UsersTab } from './UsersTab';

/** Admin console: reserved to the "amministratore" role (enforced by the server on every /api/admin call). */
export function AdminPage() {
  const tabs: Array<[string, string]> = [
    ['', t('admin.tabs.overview')],
    ['report', t('admin.tabs.reports')],
    ['risorse', t('admin.tabs.resources')],
    ['edifici', t('admin.tabs.buildings')],
    ['utenti', t('admin.tabs.users')],
    ['pannelli', t('admin.tabs.kiosks')],
    ['regole', t('admin.tabs.settings')],
    ['sincronizzazione', t('admin.tabs.sync')],
    ['registro', t('admin.tabs.audit')],
  ];
  return (
    <div>
      <div className="page-head">
        <h1>{t('admin.title')}</h1>
      </div>
      <nav className="tabs no-print">
        {tabs.map(([path, label]) => (
          <NavLink key={path} to={`/admin${path ? `/${path}` : ''}`} end className={({ isActive }) => (isActive ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<OverviewTab />} />
        <Route path="report" element={<ReportsTab />} />
        <Route path="risorse" element={<ResourcesTab />} />
        <Route path="edifici" element={<BuildingsTab />} />
        <Route path="utenti" element={<UsersTab />} />
        <Route path="pannelli" element={<KiosksTab />} />
        <Route path="regole" element={<SettingsTab />} />
        <Route path="sincronizzazione" element={<SyncTab />} />
        <Route path="registro" element={<AuditTab />} />
      </Routes>
    </div>
  );
}
