class BackfillGchatDmPrincipalConsoleUsers < ActiveRecord::Migration[8.1]
  # Google Chat parity for BackfillSlackDmPrincipalConsoleUsers. Chat DM
  # principals carry the verified requester address in the `google_email`
  # label instead of a first-class column.
  def up
    execute <<~SQL
      UPDATE principals
      SET console_user_id = users.id,
          sync_config_cache_version = principals.sync_config_cache_version + 1,
          updated_at = CURRENT_TIMESTAMP
      FROM users
      WHERE principals.kind = 'gchat_dm'
        AND principals.console_user_id IS NULL
        AND NULLIF(BTRIM(principals.labels ->> 'google_email'), '') IS NOT NULL
        AND LOWER(BTRIM(principals.labels ->> 'google_email')) = LOWER(BTRIM(users.email))
    SQL
  end

  def down; end
end
