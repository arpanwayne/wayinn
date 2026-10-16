-- 003: housekeeping / maintenance jobs raised for a guest request were left open when the request was marked Done.
-- Close the ones whose request is already finished so they stop raising "pending over N min" alerts.
UPDATE hk_tasks t
   SET status = 'done', completed_at = COALESCE(sr.resolved_at, now()), started_at = COALESCE(t.started_at, COALESCE(sr.resolved_at, now()))
  FROM service_requests sr
 WHERE t.service_request_id = sr.id AND sr.status = 'done' AND t.status IN ('pending','in_progress');

UPDATE hk_tasks t SET status = 'cancelled'
  FROM service_requests sr
 WHERE t.service_request_id = sr.id AND sr.status = 'cancelled' AND t.status IN ('pending','in_progress');

UPDATE maintenance_requests m
   SET status = 'resolved', resolved_at = COALESCE(sr.resolved_at, now()), resolution_notes = COALESCE(m.resolution_notes, 'Closed with guest request')
  FROM service_requests sr
 WHERE m.service_request_id = sr.id AND sr.status = 'done' AND m.status IN ('open','in_progress');
