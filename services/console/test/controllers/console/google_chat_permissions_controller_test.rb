require "test_helper"

module Console
  class GoogleChatPermissionsControllerTest < ActionDispatch::IntegrationTest
    setup do
      post login_url, params: { email: users(:acme_admin).email, password: "password123456" }
    end

    test "principal page renders accessible responsive Google Chat controls and inherited permissions" do
      principal = principals(:acme_channel)
      direct = principal.google_chat_space_permissions.create!(space_name: "spaces/BBBB", send_enabled: true)
      role_space = roles(:acme_infra).google_chat_space_permissions.create!(
        space_name: "spaces/AAAA", history_enabled: true
      )
      principal.google_chat_dm_permissions.create!(target_identity: "person@example.com", setup_enabled: true)
      roles(:acme_infra).google_chat_dm_permissions.create!(
        target_identity: "role@example.com", setup_enabled: true
      )

      get console_principal_url(principal.oid)
      assert_response :ok
      assert_select "form[action=?]", console_principal_google_chat_space_permissions_path(principal.oid)
      assert_select "form[action=?]", console_principal_google_chat_dm_permissions_path(principal.oid)
      assert_select "input[aria-label=?]", "Send for #{direct.space_name}"
      assert_select "button[aria-label=?]", "Delete #{direct.space_name}"
      assert_select "input[aria-label=?]", "Inherited History for #{role_space.space_name}"
      assert_select "input[aria-label='DM setup for person@example.com']"
      assert_select "input[aria-label='Inherited DM setup for role@example.com']"
      assert_select "input[placeholder='person@example.com']"
      assert_includes response.body, "overflow-x-auto"
      assert_includes response.body, "sm:grid-cols-2"
      assert_includes response.body, "xl:grid-cols-"
    end

    test "principal forms create, update and reject target changes" do
      principal = principals(:acme_user_bob)

      patch console_principal_google_chat_space_permissions_url(principal.oid), params: {
        principal: { google_chat_space_permissions_attributes: {
          "0" => { space_name: "spaces/AAAA", send_enabled: "1", history_enabled: "1" }
        } }
      }
      assert_redirected_to console_principal_path(principal.oid)
      space = principal.google_chat_space_permissions.reload.sole
      assert_predicate space, :send_enabled
      assert_predicate space, :history_enabled

      patch console_principal_google_chat_dm_permissions_url(principal.oid), params: {
        principal: { google_chat_dm_permissions_attributes: {
          "0" => { target_identity: "Person@Example.com", setup_enabled: "1" }
        } }
      }
      assert_redirected_to console_principal_path(principal.oid)
      dm = principal.google_chat_dm_permissions.reload.sole
      assert_equal "person@example.com", dm.target_identity

      patch console_principal_google_chat_space_permissions_url(principal.oid), params: {
        principal: { google_chat_space_permissions_attributes: {
          "0" => { id: space.id, space_name: "spaces/BBBB", send_enabled: "1" }
        } }
      }
      assert_equal "Google Chat spaces cannot be changed after creation.", flash[:alert]
      assert_equal "spaces/AAAA", space.reload.space_name

      patch console_principal_google_chat_dm_permissions_url(principal.oid), params: {
        principal: { google_chat_dm_permissions_attributes: {
          "0" => { id: dm.id, target_identity: "other@example.com", setup_enabled: "1" }
        } }
      }
      assert_equal "Google Chat DM targets cannot be changed after creation.", flash[:alert]
      assert_equal "person@example.com", dm.reload.target_identity
    end

    test "role forms replace permissions" do
      role = roles(:acme_admin_role)
      patch google_chat_space_permissions_console_role_url(role.oid), params: {
        role: { google_chat_space_permissions_attributes: {
          "0" => { space_name: "spaces/AAAA", members_enabled: "1" }
        } }
      }
      patch google_chat_dm_permissions_console_role_url(role.oid), params: {
        role: { google_chat_dm_permissions_attributes: {
          "0" => { target_identity: "person@example.com", setup_enabled: "1" }
        } }
      }

      assert_equal [ "spaces/AAAA" ], role.google_chat_space_permissions.reload.pluck(:space_name)
      assert_equal [ "person@example.com" ], role.google_chat_dm_permissions.reload.pluck(:target_identity)
    end

    test "delete controls remove principal and role permissions" do
      principal_permission = principals(:acme_user_bob).google_chat_space_permissions.create!(
        space_name: "spaces/AAAA", send_enabled: true
      )
      role_permission = roles(:acme_admin_role).google_chat_dm_permissions.create!(
        target_identity: "person@example.com", setup_enabled: true
      )

      delete console_google_chat_space_permission_url(principal_permission.oid)
      assert_redirected_to console_principal_path(principals(:acme_user_bob).oid)
      delete console_google_chat_dm_permission_url(role_permission.oid)
      assert_redirected_to console_role_path(roles(:acme_admin_role).oid)
      assert_raises(ActiveRecord::RecordNotFound) { principal_permission.reload }
      assert_raises(ActiveRecord::RecordNotFound) { role_permission.reload }
    end

    test "non-admin users cannot mutate permissions" do
      delete logout_url
      post login_url, params: { email: users(:member_user).email, password: "password123456" }
      principal = principals(:acme_user_bob)

      assert_no_difference -> { principal.google_chat_space_permissions.count } do
        patch console_principal_google_chat_space_permissions_url(principal.oid), params: {
          principal: { google_chat_space_permissions_attributes: {
            "0" => { space_name: "spaces/AAAA", send_enabled: "1" }
          } }
        }
      end
      assert_redirected_to console_threads_path
    end
  end
end
