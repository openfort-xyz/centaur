create or replace function centaur_current_google_chat_space_id()
returns text
language sql
stable
as $$
    select nullif(current_setting('centaur.google_chat_space_id', true), '')
$$;

grant usage on schema public to centaur_slack_reader, centaur_readonly;

grant execute on function centaur_current_google_chat_space_id()
    to centaur_slack_reader, centaur_readonly;

grant select on
    google_chat_sync_runs,
    google_chat_sync_spaces,
    google_chat_sync_messages,
    google_chat_sync_checkpoints
to centaur_slack_reader, centaur_readonly;

alter table google_chat_sync_runs enable row level security;
alter table google_chat_sync_spaces enable row level security;
alter table google_chat_sync_messages enable row level security;
alter table google_chat_sync_checkpoints enable row level security;

drop policy if exists centaur_google_chat_runs_reader_select on google_chat_sync_runs;
create policy centaur_google_chat_runs_reader_select
    on google_chat_sync_runs
    for select
    to centaur_slack_reader
    using (false);

drop policy if exists centaur_google_chat_spaces_reader_select on google_chat_sync_spaces;
create policy centaur_google_chat_spaces_reader_select
    on google_chat_sync_spaces
    for select
    to centaur_slack_reader
    using (space_id = centaur_current_google_chat_space_id());

drop policy if exists centaur_google_chat_messages_reader_select on google_chat_sync_messages;
create policy centaur_google_chat_messages_reader_select
    on google_chat_sync_messages
    for select
    to centaur_slack_reader
    using (space_id = centaur_current_google_chat_space_id());

drop policy if exists centaur_google_chat_checkpoints_reader_select
    on google_chat_sync_checkpoints;
create policy centaur_google_chat_checkpoints_reader_select
    on google_chat_sync_checkpoints
    for select
    to centaur_slack_reader
    using (false);

drop policy if exists centaur_readonly_google_chat_sync_runs_select
    on google_chat_sync_runs;
create policy centaur_readonly_google_chat_sync_runs_select
    on google_chat_sync_runs
    for select
    to centaur_readonly
    using (true);

drop policy if exists centaur_readonly_google_chat_sync_spaces_select
    on google_chat_sync_spaces;
create policy centaur_readonly_google_chat_sync_spaces_select
    on google_chat_sync_spaces
    for select
    to centaur_readonly
    using (true);

drop policy if exists centaur_readonly_google_chat_sync_messages_select
    on google_chat_sync_messages;
create policy centaur_readonly_google_chat_sync_messages_select
    on google_chat_sync_messages
    for select
    to centaur_readonly
    using (true);

drop policy if exists centaur_readonly_google_chat_sync_checkpoints_select
    on google_chat_sync_checkpoints;
create policy centaur_readonly_google_chat_sync_checkpoints_select
    on google_chat_sync_checkpoints
    for select
    to centaur_readonly
    using (true);
