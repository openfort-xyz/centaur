require "test_helper"
require Rails.root.join("db/migrate/20260813000000_create_google_chat_permissions")

class DisposableGoogleChatMigrationRecord < ActiveRecord::Base
  self.abstract_class = true
end

class CreateGoogleChatPermissionsTest < ActiveSupport::TestCase
  test "migration creates constrained permission tables and rolls back on a disposable schema" do
    schema = "google_chat_permissions_#{SecureRandom.hex(6)}"
    database = DisposableGoogleChatMigrationRecord
    database.establish_connection(
      ActiveRecord::Base.connection_db_config.configuration_hash.merge(schema_search_path: schema)
    )
    connection = database.connection
    connection.execute("CREATE SCHEMA #{connection.quote_table_name(schema)}")
    connection.schema_search_path = schema
    connection.create_table(:principals) { |t| t.timestamps }
    connection.create_table(:roles) { |t| t.timestamps }

    migration = CreateGoogleChatPermissions.new
    migration.exec_migration(connection, :up)

    assert connection.table_exists?(:google_chat_space_permissions)
    assert connection.table_exists?(:google_chat_dm_permissions)
    assert_equal 2, connection.check_constraints(:google_chat_space_permissions).size
    assert_equal 2, connection.check_constraints(:google_chat_dm_permissions).size

    migration.exec_migration(connection, :down)
    refute connection.table_exists?(:google_chat_space_permissions)
    refute connection.table_exists?(:google_chat_dm_permissions)
  ensure
    if connection
      connection.execute("DROP SCHEMA IF EXISTS #{connection.quote_table_name(schema)} CASCADE")
    end
    database&.remove_connection
  end
end
