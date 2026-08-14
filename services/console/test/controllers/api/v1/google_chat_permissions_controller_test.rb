require "test_helper"

module Api
  module V1
    class GoogleChatPermissionsControllerTest < ActionDispatch::IntegrationTest
      TOKEN = "iak_acme-ci-token".freeze

      test "principal update replaces both permission collections and returns effective payloads" do
        principal = principals(:acme_user_bob)
        body = { data: {
          google_chat_space_permissions: [
            { space_name: " SPACES/BBBB ", send_enabled: true },
            { space_name: "spaces/AAAA", history_enabled: true }
          ],
          google_chat_dm_permissions: [
            { target_identity: "Person@Example.COM", setup_enabled: true }
          ]
        } }

        put "/api/v1/principals/#{principal.oid}", params: body.to_json, headers: auth_headers
        assert_response :ok

        data = JSON.parse(response.body).fetch("data")
        assert_equal %w[spaces/AAAA spaces/BBBB], data.fetch("google_chat_space_permissions").pluck("space_name")
        assert_equal data.fetch("google_chat_space_permissions"), data.fetch("effective_google_chat_space_permissions")
        assert_equal [ "person@example.com" ], data.fetch("google_chat_dm_permissions").pluck("target_identity")
        assert_equal data.fetch("google_chat_dm_permissions"), data.fetch("effective_google_chat_dm_permissions")
      end

      test "principal space and DM endpoints upsert and delete immutable targets" do
        principal = principals(:acme_user_bob)

        post "/api/v1/principals/#{principal.oid}/google_chat_space_permissions",
             params: { data: { space_name: "spaces/AAAA", send_enabled: true } }.to_json,
             headers: auth_headers
        assert_response :created
        space = principal.google_chat_space_permissions.reload.sole

        post "/api/v1/principals/#{principal.oid}/google_chat_space_permissions",
             params: { data: { space_name: "spaces/AAAA", send_enabled: false, history_enabled: true } }.to_json,
             headers: auth_headers
        assert_response :ok
        assert_equal "spaces/AAAA", space.reload.space_name
        assert_not space.send_enabled
        assert_predicate space, :history_enabled

        post "/api/v1/principals/#{principal.oid}/google_chat_dm_permissions",
             params: { data: { target_identity: "USER@Example.com", setup_enabled: true } }.to_json,
             headers: auth_headers
        assert_response :created
        dm = principal.google_chat_dm_permissions.reload.sole
        assert_equal "user@example.com", dm.target_identity

        delete "/api/v1/principals/#{principal.oid}/google_chat_space_permissions/#{space.oid}", headers: auth_headers
        assert_response :no_content
        delete "/api/v1/principals/#{principal.oid}/google_chat_dm_permissions/#{dm.oid}", headers: auth_headers
        assert_response :no_content
        assert_empty principal.google_chat_space_permissions.reload
        assert_empty principal.google_chat_dm_permissions.reload
      end

      test "role endpoints replace, upsert and delete permissions" do
        role = roles(:acme_admin_role)
        put "/api/v1/roles/#{role.oid}", params: { data: {
          google_chat_space_permissions: [ { space_name: "spaces/AAAA", members_enabled: true } ],
          google_chat_dm_permissions: [ { target_identity: "person@example.com", setup_enabled: true } ]
        } }.to_json, headers: auth_headers
        assert_response :ok

        data = JSON.parse(response.body).fetch("data")
        assert_equal [ "spaces/AAAA" ], data.fetch("google_chat_space_permissions").pluck("space_name")
        assert_equal [ "person@example.com" ], data.fetch("google_chat_dm_permissions").pluck("target_identity")

        post "/api/v1/roles/#{role.oid}/google_chat_space_permissions",
             params: { data: { space_name: "spaces/BBBB", reactions_enabled: true } }.to_json,
             headers: auth_headers
        assert_response :created
        permission = role.google_chat_space_permissions.reload.find_by!(space_name: "spaces/BBBB")
        delete "/api/v1/roles/#{role.oid}/google_chat_space_permissions/#{permission.oid}", headers: auth_headers
        assert_response :no_content

        post "/api/v1/roles/#{role.oid}/google_chat_dm_permissions",
             params: { data: { target_identity: "other@example.com", setup_enabled: true } }.to_json,
             headers: auth_headers
        assert_response :created
        dm = role.google_chat_dm_permissions.reload.find_by!(target_identity: "other@example.com")
        delete "/api/v1/roles/#{role.oid}/google_chat_dm_permissions/#{dm.oid}", headers: auth_headers
        assert_response :no_content
      end

      test "malformed permissions and identities fail closed" do
        principal = principals(:acme_user_bob)

        put "/api/v1/principals/#{principal.oid}",
            params: { data: { google_chat_space_permissions: {} } }.to_json,
            headers: auth_headers
        assert_response :unprocessable_content
        assert_equal "google_chat_space_permissions must be an array", JSON.parse(response.body).dig("error", "message")

        post "/api/v1/principals/#{principal.oid}/google_chat_space_permissions",
             params: { data: { space_name: "spaces/AAAA/messages/M", send_enabled: true } }.to_json,
             headers: auth_headers
        assert_response :unprocessable_content

        post "/api/v1/principals/#{principal.oid}/google_chat_dm_permissions",
             params: { data: { target_identity: "users/123456789", setup_enabled: true } }.to_json,
             headers: auth_headers
        assert_response :unprocessable_content
        assert_empty principal.google_chat_space_permissions.reload
        assert_empty principal.google_chat_dm_permissions.reload
      end

      test "non-admin API keys cannot manage Google Chat permissions" do
        principal = principals(:acme_user_bob)
        post "/api/v1/principals/#{principal.oid}/google_chat_space_permissions",
             params: { data: { space_name: "spaces/AAAA", send_enabled: true } }.to_json,
             headers: auth_headers("iak_member-token")
        assert_response :forbidden
        assert_empty principal.google_chat_space_permissions.reload
      end

      private

      def auth_headers(token = TOKEN)
        { "Authorization" => "Bearer #{token}", "Content-Type" => "application/json" }
      end
    end
  end
end
