create table if not exists google_chat_sync_runs (
    run_id text primary key,
    workflow_run_id text,
    mode text not null default 'incremental',
    status text not null,
    scopes_requested jsonb not null default '[]'::jsonb,
    scopes_synced jsonb not null default '[]'::jsonb,
    scopes_failed jsonb not null default '[]'::jsonb,
    spaces_seen integer not null default 0,
    spaces_synced integer not null default 0,
    messages_seen integer not null default 0,
    messages_upserted integer not null default 0,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    error_text text not null default '',
    metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_google_chat_sync_runs_started
    on google_chat_sync_runs (started_at desc);

create table if not exists google_chat_sync_spaces (
    space_id text primary key,
    space_name text not null default '',
    display_name text not null default '',
    space_type text not null default '',
    raw_payload jsonb not null default '{}'::jsonb,
    source_run_id text references google_chat_sync_runs(run_id) on delete set null,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    last_error text not null default '',
    updated_at timestamptz not null default now()
);

create table if not exists google_chat_sync_messages (
    space_id text not null,
    message_id text not null,
    message_name text not null default '',
    thread_id text not null default '',
    sender_id text not null default '',
    sender_name text not null default '',
    sender_type text not null default '',
    text_content text not null default '',
    content_hash text not null default '',
    source_create_time timestamptz,
    source_last_update_time timestamptz,
    raw_payload jsonb not null default '{}'::jsonb,
    source_run_id text references google_chat_sync_runs(run_id) on delete set null,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    last_error text not null default '',
    updated_at timestamptz not null default now(),
    primary key (space_id, message_id)
);

create index if not exists idx_google_chat_sync_messages_thread
    on google_chat_sync_messages (space_id, thread_id);

create index if not exists idx_google_chat_sync_messages_create
    on google_chat_sync_messages (source_create_time desc);

create index if not exists idx_google_chat_sync_messages_text
    on google_chat_sync_messages
    using gin (to_tsvector('english', coalesce(text_content, '')));

create table if not exists google_chat_sync_checkpoints (
    space_id text primary key,
    watermark_time timestamptz,
    last_run_id text references google_chat_sync_runs(run_id) on delete set null,
    last_success_at timestamptz,
    last_error text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
