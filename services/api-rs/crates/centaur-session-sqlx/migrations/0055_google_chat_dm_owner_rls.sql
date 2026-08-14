alter table google_chat_sync_spaces drop constraint google_chat_sync_spaces_pkey;
alter table google_chat_sync_spaces
    add column owner_email text not null default '',
    add column participant_emails text[] not null default array[]::text[],
    add primary key (owner_email, space_id);

alter table google_chat_sync_messages drop constraint google_chat_sync_messages_pkey cascade;
alter table google_chat_sync_messages
    add column owner_email text not null default '',
    add primary key (owner_email, space_id, message_id),
    add foreign key (owner_email, space_id)
        references google_chat_sync_spaces(owner_email, space_id) on delete cascade;

alter table google_chat_sync_checkpoints drop constraint google_chat_sync_checkpoints_pkey;
alter table google_chat_sync_checkpoints
    add column owner_email text not null default '',
    add primary key (owner_email, space_id),
    add foreign key (owner_email, space_id)
        references google_chat_sync_spaces(owner_email, space_id) on delete cascade;

alter table google_chat_sync_attachments
    add column owner_email text not null default '';
alter table google_chat_sync_attachments drop constraint google_chat_sync_attachments_pkey;
alter table google_chat_sync_attachments
    add primary key (owner_email, space_id, message_id, attachment_id),
    add foreign key (owner_email, space_id, message_id)
        references google_chat_sync_messages(owner_email, space_id, message_id)
        on delete cascade;

alter table google_chat_sync_reactions
    add column owner_email text not null default '';
alter table google_chat_sync_reactions drop constraint google_chat_sync_reactions_pkey;
alter table google_chat_sync_reactions
    add primary key (owner_email, space_id, message_id, reaction_id),
    add foreign key (owner_email, space_id, message_id)
        references google_chat_sync_messages(owner_email, space_id, message_id)
        on delete cascade;

drop policy centaur_google_chat_spaces_reader_select on google_chat_sync_spaces;
create policy centaur_google_chat_spaces_reader_select
    on google_chat_sync_spaces for select to centaur_slack_reader
    using (
        (owner_email = '' and space_id = centaur_current_google_chat_space_id())
        or lower(owner_email) = centaur_current_slack_user_email()
    );
drop policy centaur_google_chat_messages_reader_select on google_chat_sync_messages;
create policy centaur_google_chat_messages_reader_select
    on google_chat_sync_messages for select to centaur_slack_reader
    using (
        (owner_email = '' and space_id = centaur_current_google_chat_space_id())
        or lower(owner_email) = centaur_current_slack_user_email()
    );
drop policy centaur_google_chat_attachments_reader_select on google_chat_sync_attachments;
create policy centaur_google_chat_attachments_reader_select
    on google_chat_sync_attachments for select to centaur_slack_reader
    using (
        (owner_email = '' and space_id = centaur_current_google_chat_space_id())
        or lower(owner_email) = centaur_current_slack_user_email()
    );
drop policy centaur_google_chat_reactions_reader_select on google_chat_sync_reactions;
create policy centaur_google_chat_reactions_reader_select
    on google_chat_sync_reactions for select to centaur_slack_reader
    using (
        (owner_email = '' and space_id = centaur_current_google_chat_space_id())
        or lower(owner_email) = centaur_current_slack_user_email()
    );

drop policy centaur_readonly_google_chat_sync_spaces_select on google_chat_sync_spaces;
create policy centaur_readonly_google_chat_sync_spaces_select
    on google_chat_sync_spaces for select to centaur_readonly
    using (owner_email = '' or lower(owner_email) = centaur_current_slack_user_email());
drop policy centaur_readonly_google_chat_sync_messages_select on google_chat_sync_messages;
create policy centaur_readonly_google_chat_sync_messages_select
    on google_chat_sync_messages for select to centaur_readonly
    using (owner_email = '' or lower(owner_email) = centaur_current_slack_user_email());
drop policy centaur_readonly_google_chat_sync_attachments_select on google_chat_sync_attachments;
create policy centaur_readonly_google_chat_sync_attachments_select
    on google_chat_sync_attachments for select to centaur_readonly
    using (owner_email = '' or lower(owner_email) = centaur_current_slack_user_email());
drop policy centaur_readonly_google_chat_sync_reactions_select on google_chat_sync_reactions;
create policy centaur_readonly_google_chat_sync_reactions_select
    on google_chat_sync_reactions for select to centaur_readonly
    using (owner_email = '' or lower(owner_email) = centaur_current_slack_user_email());
drop policy centaur_readonly_google_chat_sync_checkpoints_select on google_chat_sync_checkpoints;
create policy centaur_readonly_google_chat_sync_checkpoints_select
    on google_chat_sync_checkpoints for select to centaur_readonly
    using (owner_email = '' or lower(owner_email) = centaur_current_slack_user_email());

grant execute on function centaur_current_slack_user_email()
    to centaur_slack_reader, centaur_readonly;
