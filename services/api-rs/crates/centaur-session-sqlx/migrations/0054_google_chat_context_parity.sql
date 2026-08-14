alter table google_chat_sync_checkpoints
    add column if not exists continuation_token text not null default '',
    add column if not exists continuation_filter text not null default '',
    add column if not exists continuation_started_at timestamptz,
    add column if not exists continuation_updated_at timestamptz;

create table if not exists google_chat_sync_attachments (
    space_id text not null,
    message_id text not null,
    attachment_id text not null,
    attachment_name text not null default '',
    content_name text not null default '',
    content_type text not null default '',
    source_uri text not null default '',
    download_uri text not null default '',
    size_bytes bigint,
    content_text text not null default '',
    raw_payload jsonb not null default '{}'::jsonb,
    source_run_id text references google_chat_sync_runs(run_id) on delete set null,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (space_id, message_id, attachment_id),
    foreign key (space_id, message_id)
        references google_chat_sync_messages(space_id, message_id) on delete cascade
);

create index if not exists idx_google_chat_sync_attachments_updated
    on google_chat_sync_attachments (updated_at, space_id, message_id, attachment_id);

create table if not exists google_chat_sync_reactions (
    space_id text not null,
    message_id text not null,
    reaction_id text not null,
    user_id text not null default '',
    emoji_unicode text not null default '',
    custom_emoji_uid text not null default '',
    raw_payload jsonb not null default '{}'::jsonb,
    source_run_id text references google_chat_sync_runs(run_id) on delete set null,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (space_id, message_id, reaction_id),
    foreign key (space_id, message_id)
        references google_chat_sync_messages(space_id, message_id) on delete cascade
);

create index if not exists idx_google_chat_sync_reactions_message
    on google_chat_sync_reactions (space_id, message_id);

grant select on google_chat_sync_attachments, google_chat_sync_reactions
    to centaur_slack_reader, centaur_readonly;

alter table google_chat_sync_attachments enable row level security;
alter table google_chat_sync_reactions enable row level security;

create policy centaur_google_chat_attachments_reader_select
    on google_chat_sync_attachments for select to centaur_slack_reader
    using (space_id = centaur_current_google_chat_space_id());
create policy centaur_google_chat_reactions_reader_select
    on google_chat_sync_reactions for select to centaur_slack_reader
    using (space_id = centaur_current_google_chat_space_id());
create policy centaur_readonly_google_chat_sync_attachments_select
    on google_chat_sync_attachments for select to centaur_readonly using (true);
create policy centaur_readonly_google_chat_sync_reactions_select
    on google_chat_sync_reactions for select to centaur_readonly using (true);

drop policy if exists centaur_context_docs_reader_select on company_context_documents;
create policy centaur_context_docs_reader_select
    on company_context_documents for select to centaur_slack_reader
    using (
        (
            source = 'slack'
            and metadata ->> 'channel_id' = centaur_current_slack_channel_id()
        )
        or (
            source = 'google_chat'
            and metadata ->> 'space_id' = centaur_current_google_chat_space_id()
        )
    );
