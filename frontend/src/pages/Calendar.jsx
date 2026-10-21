import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { addDays, todayStr, nights, fmtDate } from '../lib/format.js';
import { PageHeader, Loading, Badge } from '../components/ui.jsx';

const COLORS = { reserved: 'bg-night-100 text-night-900 ring-1 ring-inset ring-night-300', checked_in: 'bg-night-900 text-white', checked_out: 'bg-ink-200 text-ink-600', tentative: 'bg-amber-300 text-ink-900' };

export default function Calendar() {
  const [from, setFrom] = useState(todayStr());
  const [span, setSpan] = useState(14);
  const to = addDays(from, span);
  const { data } = useApi(`/calendar?from=${from}&to=${to}`, { interval: 60000 });
  const nav = useNavigate();
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(from, i)), [from, span]);
  const CELL = span > 14 ? 40 : 64;
  // Bookings with no room yet still take inventory: show them as bars in an "Unassigned" block, stacked so none overlap.
  const lanes = useMemo(() => {
    const out = [];
    for (const s of data?.unallocated || []) {
      let lane = out.find((l) => l.every((x) => x.check_out_date <= s.check_in_date || x.check_in_date >= s.check_out_date));
      if (!lane) { lane = []; out.push(lane); }
      lane.push(s);
    }
    return out;
  }, [data]);
  const bar = (s) => {
    const start = s.check_in_date < from ? from : s.check_in_date;
    const end = s.check_out_date > to ? to : s.check_out_date;
    const cut = s.check_in_date < from;
    return { left: cut ? 140 : 140 + nights(from, start) * CELL + CELL / 2, width: Math.max(nights(start, end) * CELL - 4, 12) + (cut ? CELL / 2 : 0) };
  };

  return (
    <div>
      <PageHeader title="Reservation calendar" subtitle="Room-wise view. Click an empty cell to book."
        actions={<>
          <button className="btn-secondary" onClick={() => setFrom(addDays(from, -7))}>‹ Week</button>
          <button className="btn-secondary" onClick={() => setFrom(todayStr())}>Today</button>
          <button className="btn-secondary" onClick={() => setFrom(addDays(from, 7))}>Week ›</button>
          <select className="input w-auto" value={span} onChange={(e) => setSpan(Number(e.target.value))}>
            <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
          </select>
        </>} />
      {!data ? <Loading /> : (
        <div className="card overflow-x-auto">
          <div style={{ minWidth: 140 + CELL * span }}>
            <div className="sticky top-0 flex border-b border-ink-100 bg-white text-xs">
              <div className="w-[140px] shrink-0 px-3 py-2 font-semibold text-ink-400">Room</div>
              {days.map((d) => {
                const dt = new Date(d + 'T00:00:00');
                const wk = dt.getDay() === 0 || dt.getDay() === 6;
                return (
                  <div key={d} style={{ width: CELL }} className={`shrink-0 border-l border-ink-50 py-2 text-center ${d === todayStr() ? 'bg-night-900 font-bold text-white' : wk ? 'bg-ink-50 text-ink-500' : 'text-ink-500'}`}>
                    <div>{dt.toLocaleDateString('en-IN', { weekday: 'short' })}</div><div className="font-semibold">{dt.getDate()}</div>
                  </div>
                );
              })}
            </div>
            {lanes.length > 0 && (
              <div>
                <div className="border-b border-ink-100 bg-amber-50 px-3 py-1 text-[11px] font-semibold tracking-wide text-amber-600">NO ROOM ASSIGNED YET · {data.unallocated.length}</div>
                {lanes.map((lane, li) => (
                  <div key={li} className="relative flex h-10 border-b border-ink-50">
                    <div className="flex w-[140px] shrink-0 items-center px-3 text-sm font-semibold text-ink-500">Unassigned</div>
                    {days.map((d) => <div key={d} style={{ width: CELL }} className="shrink-0 border-l border-ink-50" />)}
                    {lane.map((s) => {
                      const b = bar(s);
                      return (
                        <Link key={s.id} to={`/bookings/${s.booking_id}`} title={`${s.guest_name} · ${s.ref} · ${fmtDate(s.check_in_date)}–${fmtDate(s.check_out_date)} · no room yet`}
                          style={{ left: b.left, width: b.width }}
                          className={`absolute top-1.5 flex h-7 items-center overflow-hidden rounded-lg border border-dashed border-amber-400 px-2 text-xs font-semibold ${COLORS[s.status] || 'bg-amber-100 text-ink-900'}`}>
                          <span className="truncate">{s.guest_name}</span>
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            {data.rooms.map((room, idx) => {
              const prev = data.rooms[idx - 1];
              const stays = data.stays.filter((s) => s.room_id === room.id);
              return (
                <div key={room.id}>
                  {(!prev || prev.room_type_id !== room.room_type_id) && (
                    <div className="border-b border-ink-100 bg-ink-50 px-3 py-1 text-[11px] font-semibold tracking-wide text-ink-400">{room.room_type}</div>
                  )}
                  <div className="relative flex h-10 border-b border-ink-50">
                    <div className="flex w-[140px] shrink-0 items-center gap-2 px-3 text-sm font-semibold">
                      {room.number} {room.hk_status === 'out_of_order' && <Badge status="out_of_order">OOO</Badge>}
                    </div>
                    {days.map((d) => (
                      <button key={d} style={{ width: CELL }} title={`Book ${room.number} on ${d}`}
                        className="shrink-0 border-l border-ink-50 hover:bg-night-50"
                        onClick={() => nav(`/bookings/new?room_id=${room.id}&room_type_id=${room.room_type_id}&from=${d}&to=${addDays(d, 1)}`)} />
                    ))}
                    {stays.map((s) => {
                      const start = s.check_in_date < from ? from : s.check_in_date;
                      const end = s.check_out_date > to ? to : s.check_out_date;
                      const left = 140 + nights(from, start) * CELL + CELL / 2;
                      const width = Math.max(nights(start, end) * CELL - 4, 12);
                      return (
                        <Link key={s.id} to={`/bookings/${s.booking_id}`} title={`${s.guest_name} · ${s.ref} · ${fmtDate(s.check_in_date)}–${fmtDate(s.check_out_date)}`}
                          style={{ left: s.check_in_date < from ? 140 : left, width: s.check_in_date < from ? width + CELL / 2 : width }}
                          className={`absolute top-1.5 flex h-7 items-center overflow-hidden rounded-lg px-2 text-xs font-semibold shadow-xs ${COLORS[s.status] || 'bg-ink-400 text-white'}`}>
                          <span className="truncate">{s.guest_name}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {data?.unallocated?.length > 0 && (
        <div className="card mt-5 p-4">
          <h2 className="mb-2">Bookings without a room ({data.unallocated.length})</h2>
          <div className="flex flex-wrap gap-2">
            {data.unallocated.map((s) => (
              <Link key={s.id} to={`/bookings/${s.booking_id}`} className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50">
                {s.guest_name} · {fmtDate(s.check_in_date)}–{fmtDate(s.check_out_date)} <Badge status={s.status} />
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-ink-500">
        {Object.entries({ reserved: 'Reserved', checked_in: 'In house', checked_out: 'Departed', tentative: 'Requested' }).map(([k, l]) => (
          <span key={k} className="flex items-center gap-1.5"><span className={`h-3 w-3 rounded-sm ${COLORS[k]}`} />{l}</span>
        ))}
      </div>
    </div>
  );
}
