import type { BuildingDto, ResourceDto } from '@ritrovo/shared';
import { useState, type FormEvent, type MouseEvent } from 'react';
import { ErrorBox, Field, Spinner, useAsync, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { useSession } from '../../session';

/** Buildings, floors, floor plans and placement of desks/rooms on the plan (click to place). */
export function BuildingsTab() {
  const { api } = useSession();
  const toast = useToast();
  const buildings = useAsync(() => api.get<BuildingDto[]>('/api/buildings'), []);
  const resources = useAsync(() => api.get<ResourceDto[]>('/api/admin/resources'), []);
  const [floorId, setFloorId] = useState('');
  const [placing, setPlacing] = useState<ResourceDto | null>(null);
  const [newBuilding, setNewBuilding] = useState({ name: '', address: '' });
  const [newFloor, setNewFloor] = useState({ buildingId: '', name: '' });
  const [error, setError] = useState<unknown>(null);

  const floors = (buildings.data ?? []).flatMap((b) => b.floors.map((f) => ({ ...f, buildingName: b.name })));
  const floor = floors.find((f) => f.id === floorId);
  const onFloor = (resources.data ?? []).filter((r) => r.floorId === floorId);

  const createBuilding = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/admin/buildings', { name: newBuilding.name, address: newBuilding.address || undefined });
      setNewBuilding({ name: '', address: '' });
      buildings.reload();
    } catch (err) {
      setError(err);
    }
  };

  const createFloor = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/admin/floors', { buildingId: newFloor.buildingId, name: newFloor.name, sortOrder: floors.length });
      setNewFloor({ buildingId: '', name: '' });
      buildings.reload();
    } catch (err) {
      setError(err);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file || !floor) return;
    if (file.size > 2 * 1024 * 1024) return toast(t('admin.buildings.uploadMap'), 'error');
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      await api.put(`/api/admin/floors/${floor.id}/map`, { mime: file.type, dataBase64: btoa(bin) });
      toast(t('admin.buildings.uploaded'));
      buildings.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const place = async (e: MouseEvent<HTMLDivElement>) => {
    if (!placing) return;
    const box = e.currentTarget.getBoundingClientRect();
    const mapX = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const mapY = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    try {
      await api.patch(`/api/admin/resources/${placing.id}`, { mapX, mapY, floorId, buildingId: floor ? buildings.data?.find((b) => b.floors.some((f) => f.id === floorId))?.id : undefined });
      toast(t('admin.buildings.placed'));
      setPlacing(null);
      resources.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <ErrorBox error={error ?? buildings.error} />
      {buildings.loading && !buildings.data && <Spinner />}
      <div className="grid grid-2">
        <form className="card stack" onSubmit={createBuilding}>
          <h2>{t('admin.buildings.newBuilding')}</h2>
          <Field label={t('admin.resources.name')}>
            <input required value={newBuilding.name} onChange={(e) => setNewBuilding({ ...newBuilding, name: e.target.value })} />
          </Field>
          <Field label={t('admin.buildings.address')}>
            <input value={newBuilding.address} onChange={(e) => setNewBuilding({ ...newBuilding, address: e.target.value })} />
          </Field>
          <button className="btn">{t('common.create')}</button>
        </form>
        <form className="card stack" onSubmit={createFloor}>
          <h2>{t('admin.buildings.newFloor')}</h2>
          <Field label={t('common.building')}>
            <select required value={newFloor.buildingId} onChange={(e) => setNewFloor({ ...newFloor, buildingId: e.target.value })}>
              <option value="">—</option>
              {buildings.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('admin.resources.name')}>
            <input required value={newFloor.name} onChange={(e) => setNewFloor({ ...newFloor, name: e.target.value })} />
          </Field>
          <button className="btn">{t('common.create')}</button>
        </form>
      </div>
      <section className="card stack">
        <div className="row">
          <Field label={t('common.floor')}>
            <select value={floorId} onChange={(e) => setFloorId(e.target.value)}>
              <option value="">{t('admin.buildings.selectFloor')}</option>
              {floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.buildingName} – {f.name}
                </option>
              ))}
            </select>
          </Field>
          {floor && (
            <Field label={t('admin.buildings.uploadMap')}>
              <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onChange={(e) => void upload(e.target.files?.[0])} />
            </Field>
          )}
        </div>
        {floor && (
          <>
            <p className="small muted">{placing ? t('admin.buildings.placing', { name: placing.name }) : t('admin.buildings.placeHint')}</p>
            <div className="two-col">
              <div className={`floormap ${placing ? 'placing' : ''}`} onClick={(e) => void place(e)}>
                {floor.hasMap ? <img src={`/api/floors/${floor.id}/map?v=${floor.mapVersion ?? ''}`} alt={floor.name} /> : <div className="empty">{t('desks.noMap')}</div>}
                {onFloor
                  .filter((r) => r.mapX !== null && r.mapY !== null)
                  .map((r) => (
                    <span key={r.id} className={`marker free ${r.kind === 'room' ? 'room' : ''}`} style={{ left: `${r.mapX! * 100}%`, top: `${r.mapY! * 100}%`, pointerEvents: 'none' }}>
                      {r.kind === 'room' ? '◯' : r.name}
                    </span>
                  ))}
              </div>
              <div className="stack" style={{ gap: 4 }}>
                {(resources.data ?? [])
                  .filter((r) => r.floorId === floorId || r.floorId === null)
                  .map((r) => (
                    <button key={r.id} className={`btn small ${placing?.id === r.id ? 'primary' : ''}`} style={{ justifyContent: 'space-between' }} onClick={() => setPlacing(r)}>
                      <span>
                        {t(`kinds.${r.kind}`)} {r.name}
                      </span>
                      <span className="muted">{r.mapX !== null && r.floorId === floorId ? '●' : '○'}</span>
                    </button>
                  ))}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
