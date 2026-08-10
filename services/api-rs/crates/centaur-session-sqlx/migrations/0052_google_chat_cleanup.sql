-- Drop the two `using (false)` reader policies from 0037: the tables already
-- have row level security enabled, and Postgres denies every row to a role no
-- policy applies to, so these only restated the default. The centaur_readonly
-- policies match per-role via their `to` clause and are unaffected.
drop policy if exists centaur_google_chat_runs_reader_select on google_chat_sync_runs;
drop policy if exists centaur_google_chat_checkpoints_reader_select on google_chat_sync_checkpoints;

-- content_hash was written on every upsert and never read or compared; the
-- upsert overwrites unconditionally, so it bought no change detection.
alter table google_chat_sync_messages drop column if exists content_hash;
