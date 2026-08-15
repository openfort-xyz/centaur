class CreateGoogleChatPermissions < ActiveRecord::Migration[8.1]
  def change
    create_table :google_chat_space_permissions do |t|
      t.references :principal, foreign_key: true
      t.references :role, foreign_key: true
      t.string :space_name, null: false
      t.boolean :send_enabled, null: false, default: false
      t.boolean :update_enabled, null: false, default: false
      t.boolean :delete_enabled, null: false, default: false
      t.boolean :upload_enabled, null: false, default: false
      t.boolean :download_enabled, null: false, default: false
      t.boolean :history_enabled, null: false, default: false
      t.boolean :members_enabled, null: false, default: false
      t.boolean :reactions_enabled, null: false, default: false

      t.timestamps
    end

    add_index :google_chat_space_permissions, %i[principal_id space_name],
              unique: true, where: "principal_id IS NOT NULL"
    add_index :google_chat_space_permissions, %i[role_id space_name],
              unique: true, where: "role_id IS NOT NULL"
    add_check_constraint :google_chat_space_permissions,
                         "(principal_id IS NULL) <> (role_id IS NULL)",
                         name: "google_chat_space_permissions_exactly_one_grantee"
    add_check_constraint :google_chat_space_permissions,
                         <<~SQL.squish,
                           send_enabled OR update_enabled OR delete_enabled OR upload_enabled OR
                           download_enabled OR history_enabled OR members_enabled OR reactions_enabled
                         SQL
                         name: "google_chat_space_permissions_at_least_one_permission"

    create_table :google_chat_dm_permissions do |t|
      t.references :principal, foreign_key: true
      t.references :role, foreign_key: true
      t.string :target_identity, null: false
      t.boolean :setup_enabled, null: false, default: false

      t.timestamps
    end

    add_index :google_chat_dm_permissions, %i[principal_id target_identity],
              unique: true, where: "principal_id IS NOT NULL"
    add_index :google_chat_dm_permissions, %i[role_id target_identity],
              unique: true, where: "role_id IS NOT NULL"
    add_check_constraint :google_chat_dm_permissions,
                         "(principal_id IS NULL) <> (role_id IS NULL)",
                         name: "google_chat_dm_permissions_exactly_one_grantee"
    add_check_constraint :google_chat_dm_permissions, "setup_enabled",
                         name: "google_chat_dm_permissions_setup_enabled"
  end
end
