require "test_helper"

module Api
  module V1
    class ConsoleGoogleChatPermissionsTest < ActionDispatch::IntegrationTest
      SPACE_FLAGS_OFF = GoogleChatSpacePermission::PERMISSION_ATTRIBUTE_NAMES.to_h { |flag| [ flag, false ] }.freeze

      setup do
        @operator = users(:acme_admin)
        sign_in_console(@operator)
      end

      test "Google Chat permission endpoints are admin-only for principals and roles" do
        principal = principals(:acme_user_bob)
        role = roles(:acme_infra)
        principal.google_chat_space_permissions.create!(space_name: "spaces/AAAA", send_enabled: true)
        principal.google_chat_dm_permissions.create!(target_identity: "a@example.com", setup_enabled: true)

        assert_admin_only_api :put, google_chat_space_permissions_api_v1_console_principal_path(principal.oid),
                              params: { data: { google_chat_space_permissions: [] } }
        assert_admin_only_api :delete, google_chat_space_permission_api_v1_console_principal_path(principal.oid, "AAAA")
        assert_admin_only_api :put, google_chat_dm_permissions_api_v1_console_principal_path(principal.oid),
                              params: { data: { google_chat_dm_permissions: [] } }
        assert_admin_only_api :delete,
                              google_chat_dm_permission_api_v1_console_principal_path(principal.oid, "a@example.com")
        assert_admin_only_api :put, google_chat_space_permissions_api_v1_console_role_path(role.oid),
                              params: { data: { google_chat_space_permissions: [] } }
        assert_admin_only_api :put, google_chat_dm_permissions_api_v1_console_role_path(role.oid),
                              params: { data: { google_chat_dm_permissions: [] } }

        assert_equal [ "spaces/AAAA" ], principal.google_chat_space_permissions.reload.pluck(:space_name)
        assert_equal [ "a@example.com" ], principal.google_chat_dm_permissions.reload.pluck(:target_identity)
      end

      test "replacing principal space permissions stores the submitted rows" do
        principal = principals(:acme_user_bob)
        principal.google_chat_space_permissions.create!(space_name: "spaces/OLD1", send_enabled: true)

        put google_chat_space_permissions_api_v1_console_principal_path(principal.oid),
            params: { data: { google_chat_space_permissions: [
              { space_name: "Spaces/AAAA", send_enabled: true, history_enabled: true }
            ] } }, headers: csrf_headers, as: :json

        assert_response :ok
        expected = [ SPACE_FLAGS_OFF.merge("space_name" => "spaces/AAAA", "send_enabled" => true,
                                           "history_enabled" => true) ]
        assert_equal expected, json_body["data"]
        assert_equal expected, principal.reload.google_chat_space_permissions_payload
      end

      test "an unchanged space replacement writes nothing" do
        principal = principals(:acme_user_bob)
        permission = principal.google_chat_space_permissions.create!(space_name: "spaces/AAAA", send_enabled: true)

        assert_no_changes -> { principal.reload.sync_config_cache_version } do
          put google_chat_space_permissions_api_v1_console_principal_path(principal.oid),
              params: { data: { google_chat_space_permissions: [ permission.as_permission_json ] } },
              headers: csrf_headers, as: :json
        end
        assert_response :ok
        assert_equal [ permission.id ], principal.google_chat_space_permissions.reload.pluck(:id)
      end

      test "replacing rejects invalid space rows without writing" do
        principal = principals(:acme_user_bob)
        principal.google_chat_space_permissions.create!(space_name: "spaces/KEEP", send_enabled: true)

        put google_chat_space_permissions_api_v1_console_principal_path(principal.oid),
            params: { data: { google_chat_space_permissions: [ { space_name: "spaces/AAAA" } ] } },
            headers: csrf_headers, as: :json
        assert_response :unprocessable_entity

        put google_chat_space_permissions_api_v1_console_principal_path(principal.oid),
            params: { data: { google_chat_space_permissions: [ { space_name: "not-a-space", send_enabled: true } ] } },
            headers: csrf_headers, as: :json
        assert_response :unprocessable_entity

        put google_chat_space_permissions_api_v1_console_principal_path(principal.oid),
            params: { data: { google_chat_space_permissions: "spaces/AAAA" } }, headers: csrf_headers, as: :json
        assert_response :unprocessable_entity

        assert_equal [ "spaces/KEEP" ], principal.google_chat_space_permissions.reload.pluck(:space_name)
      end

      test "a single principal space permission can be deleted" do
        principal = principals(:acme_user_bob)
        principal.google_chat_space_permissions.create!(space_name: "spaces/AAAA", send_enabled: true)
        principal.google_chat_space_permissions.create!(space_name: "spaces/BBBB", send_enabled: true)

        delete google_chat_space_permission_api_v1_console_principal_path(principal.oid, "AAAA"), headers: csrf_headers
        assert_response :no_content
        assert_equal [ "spaces/BBBB" ], principal.google_chat_space_permissions.reload.pluck(:space_name)

        delete google_chat_space_permission_api_v1_console_principal_path(principal.oid, "AAAA"), headers: csrf_headers
        assert_response :not_found
      end

      test "replacing and deleting principal DM permissions" do
        principal = principals(:acme_user_bob)

        put google_chat_dm_permissions_api_v1_console_principal_path(principal.oid),
            params: { data: { google_chat_dm_permissions: [
              { target_identity: " Person@Example.com ", setup_enabled: true }
            ] } }, headers: csrf_headers, as: :json
        assert_response :ok
        assert_equal [ { "target_identity" => "person@example.com", "setup_enabled" => true } ], json_body["data"]

        delete google_chat_dm_permission_api_v1_console_principal_path(principal.oid, "person@example.com"),
               headers: csrf_headers
        assert_response :no_content
        assert_empty principal.google_chat_dm_permissions.reload

        delete google_chat_dm_permission_api_v1_console_principal_path(principal.oid, "person@example.com"),
               headers: csrf_headers
        assert_response :not_found
      end

      test "replacing rejects invalid DM rows without writing" do
        principal = principals(:acme_user_bob)

        put google_chat_dm_permissions_api_v1_console_principal_path(principal.oid),
            params: { data: { google_chat_dm_permissions: [ { target_identity: "users/123", setup_enabled: true } ] } },
            headers: csrf_headers, as: :json
        assert_response :unprocessable_entity

        put google_chat_dm_permissions_api_v1_console_principal_path(principal.oid),
            params: { data: { google_chat_dm_permissions: [
              { target_identity: "person@example.com", setup_enabled: false }
            ] } }, headers: csrf_headers, as: :json
        assert_response :unprocessable_entity

        assert_empty principal.google_chat_dm_permissions.reload
      end

      test "the console principal payload includes direct and inherited Google Chat permissions" do
        principal = principals(:acme_user_bob)
        principal.roles << roles(:acme_infra) unless principal.roles.include?(roles(:acme_infra))
        principal.google_chat_space_permissions.create!(space_name: "spaces/OWN1", send_enabled: true)
        roles(:acme_infra).google_chat_space_permissions.create!(space_name: "spaces/ROLE", history_enabled: true)
        roles(:acme_infra).google_chat_dm_permissions.create!(target_identity: "r@example.com", setup_enabled: true)

        get api_v1_console_principal_path(principal.oid)

        data = json_body["data"]
        assert_equal [ "spaces/OWN1" ], data["google_chat_space_permissions"].map { |row| row["space_name"] }
        assert_equal [ "spaces/ROLE" ], data["inherited_google_chat_space_permissions"].map { |row| row["space_name"] }
        assert_equal [ "r@example.com" ],
                     data["inherited_google_chat_dm_permissions"].map { |row| row["target_identity"] }
      end

      test "replacing role permissions bumps the sync config of the role's principals" do
        role = roles(:acme_infra)
        principal = principals(:acme_user_bob)
        principal.roles << role unless principal.roles.include?(role)

        assert_changes -> { principal.reload.sync_config_cache_version } do
          put google_chat_space_permissions_api_v1_console_role_path(role.oid),
              params: { data: { google_chat_space_permissions: [ { space_name: "spaces/AAAA", send_enabled: true } ] } },
              headers: csrf_headers, as: :json
        end
        assert_response :ok
        assert_equal [ "spaces/AAAA" ], role.google_chat_space_permissions.reload.pluck(:space_name)

        put google_chat_dm_permissions_api_v1_console_role_path(role.oid),
            params: { data: { google_chat_dm_permissions: [ { target_identity: "a@example.com", setup_enabled: true } ] } },
            headers: csrf_headers, as: :json
        assert_response :ok

        get api_v1_console_role_path(role.oid)
        assert_equal [ "a@example.com" ],
                     json_body.dig("data", "google_chat_dm_permissions").map { |row| row["target_identity"] }

        delete google_chat_space_permission_api_v1_console_role_path(role.oid, "AAAA"), headers: csrf_headers
        assert_response :no_content
        delete google_chat_dm_permission_api_v1_console_role_path(role.oid, "a@example.com"), headers: csrf_headers
        assert_response :no_content
        assert_empty role.google_chat_space_permissions.reload
        assert_empty role.google_chat_dm_permissions.reload
      end

      test "deleting another owner's Google Chat permission is a 404" do
        other = roles(:acme_admin_role)
        permission = other.google_chat_space_permissions.create!(space_name: "spaces/AAAA", send_enabled: true)

        delete google_chat_space_permission_api_v1_console_role_path(roles(:acme_infra).oid, "AAAA"),
               headers: csrf_headers
        assert_response :not_found
        assert_predicate permission.reload, :persisted?
      end
    end
  end
end
