update features f
set approved_policy = '{"orderedModels":[]}', desired_version = active_version, reconcile_needed = true
where approved_policy = '{"orderedModels":[],"useRegistrationPreference":false}'
  and not exists (select 1 from route_versions r where r.feature_id = f.id and r.origin = 'manual');
