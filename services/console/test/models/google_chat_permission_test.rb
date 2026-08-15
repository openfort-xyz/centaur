require "test_helper"

class GoogleChatPermissionTest < ActiveSupport::TestCase
  test "space permissions normalize resources, validate flags and keep targets immutable" do
    permission = GoogleChatSpacePermission.create!(
      principal: principals(:acme_user_bob),
      space_name: " SPACES/Abc_123 ",
      send_enabled: true
    )

    assert_equal "spaces/Abc_123", permission.space_name
    assert_raises(ActiveRecord::ReadonlyAttributeError) { permission.update!(space_name: "spaces/Other") }

    invalid = GoogleChatSpacePermission.new(
      principal: principals(:acme_user_bob), space_name: "spaces/Abc/messages/M"
    )
    assert_not invalid.valid?
    assert_includes invalid.errors[:space_name], "is not a valid Google Chat space name"
    assert_includes invalid.errors[:base], "Select at least one Google Chat space permission"
  end

  test "space permissions require exactly one grantee and reject duplicates" do
    role = roles(:acme_infra)
    principal = principals(:acme_user_bob)
    role.google_chat_space_permissions.create!(space_name: "spaces/AAAA", history_enabled: true)

    duplicate = role.google_chat_space_permissions.new(space_name: "spaces/AAAA", send_enabled: true)
    assert_not duplicate.valid?
    assert_includes duplicate.errors[:space_name], "has already been taken"

    missing = GoogleChatSpacePermission.new(space_name: "spaces/BBBB", send_enabled: true)
    both = GoogleChatSpacePermission.new(
      principal: principal, role: role, space_name: "spaces/BBBB", send_enabled: true
    )
    [ missing, both ].each do |permission|
      assert_not permission.valid?
      assert_includes permission.errors[:base], "must reference exactly one of principal, role"
    end

    assert_raises ActiveRecord::StatementInvalid do
      GoogleChatSpacePermission.transaction(requires_new: true) do
        GoogleChatSpacePermission.insert_all!([ {
          principal_id: principal.id, role_id: role.id, space_name: "spaces/CCCC",
          send_enabled: true, update_enabled: false, delete_enabled: false, upload_enabled: false,
          download_enabled: false, history_enabled: false, members_enabled: false, reactions_enabled: false,
          created_at: Time.current, updated_at: Time.current
        } ])
      end
    end
  end

  test "replacement merges duplicate space rows with OR semantics and invalidates role members once" do
    role = roles(:acme_infra)
    versions = Principal.where(id: role.principal_ids).pluck(:id, :sync_config_cache_version).to_h

    GoogleChatSpacePermission.replace_for!(role, [
      { space_name: " spaces/BBBB ", send_enabled: true },
      { space_name: "spaces/AAAA", history_enabled: true },
      { space_name: "spaces/BBBB", members_enabled: true }
    ])

    assert_equal %w[spaces/AAAA spaces/BBBB], role.google_chat_space_permissions.reload.ordered.pluck(:space_name)
    merged = role.google_chat_space_permissions.find_by!(space_name: "spaces/BBBB")
    assert_predicate merged, :send_enabled
    assert_predicate merged, :members_enabled
    Principal.where(id: role.principal_ids).find_each do |principal|
      assert_equal versions.fetch(principal.id) + 1, principal.sync_config_cache_version
    end
  end

  test "direct and role space permissions merge per flag and deletion invalidates the cache" do
    principal = principals(:acme_channel)
    role = roles(:acme_infra)
    direct = principal.google_chat_space_permissions.create!(space_name: "spaces/AAAA", send_enabled: true)
    role.google_chat_space_permissions.create!(space_name: "spaces/AAAA", history_enabled: true)

    assert_equal({
      "space_name" => "spaces/AAAA",
      "send_enabled" => true,
      "update_enabled" => false,
      "delete_enabled" => false,
      "upload_enabled" => false,
      "download_enabled" => false,
      "history_enabled" => true,
      "members_enabled" => false,
      "reactions_enabled" => false
    }, principal.effective_google_chat_space_permissions_payload.sole)

    version = principal.reload.sync_config_cache_version
    direct.destroy!
    assert_equal version + 1, principal.reload.sync_config_cache_version
  end

  test "DM permissions normalize email, reject user resources and keep targets immutable" do
    principal = principals(:acme_user_bob)
    email = principal.google_chat_dm_permissions.create!(target_identity: " Person@Example.COM ", setup_enabled: true)

    assert_equal "person@example.com", email.target_identity
    assert_raises(ActiveRecord::ReadonlyAttributeError) { email.update!(target_identity: "other@example.com") }

    [ "users/123456789", "users/person@example.com" ].each do |target|
      invalid = principal.google_chat_dm_permissions.new(target_identity: target, setup_enabled: true)
      assert_not invalid.valid?
      assert_includes invalid.errors[:target_identity], "must be an email address"
    end
  end

  test "DM permissions require exactly one grantee and reject duplicates" do
    principal = principals(:acme_user_bob)
    role = roles(:acme_infra)
    role.google_chat_dm_permissions.create!(target_identity: "person@example.com", setup_enabled: true)

    duplicate = role.google_chat_dm_permissions.new(
      target_identity: "PERSON@example.com", setup_enabled: true
    )
    assert_not duplicate.valid?
    assert_includes duplicate.errors[:target_identity], "has already been taken"

    missing = GoogleChatDmPermission.new(target_identity: "other@example.com", setup_enabled: true)
    both = GoogleChatDmPermission.new(
      principal: principal, role: role, target_identity: "other@example.com", setup_enabled: true
    )
    [ missing, both ].each do |permission|
      assert_not permission.valid?
      assert_includes permission.errors[:base], "must reference exactly one of principal, role"
    end

    assert_raises ActiveRecord::StatementInvalid do
      GoogleChatDmPermission.transaction(requires_new: true) do
        GoogleChatDmPermission.insert_all!([ {
          principal_id: principal.id, role_id: role.id, target_identity: "third@example.com",
          setup_enabled: true, created_at: Time.current, updated_at: Time.current
        } ])
      end
    end
  end

  test "DM replacement merges role and direct grants and rejects disabled rows" do
    principal = principals(:acme_channel)
    role = roles(:acme_infra)
    direct = principal.google_chat_dm_permissions.create!(
      target_identity: "person@example.com", setup_enabled: true
    )
    role.google_chat_dm_permissions.create!(target_identity: "PERSON@example.com", setup_enabled: true)

    assert_equal [ {
      "target_identity" => "person@example.com", "setup_enabled" => true
    } ], principal.effective_google_chat_dm_permissions_payload

    assert_raises ActiveRecord::RecordInvalid do
      GoogleChatDmPermission.replace_for!(principal, [
        { target_identity: "other@example.com", setup_enabled: false }
      ])
    end
    assert_equal [ "person@example.com" ], principal.google_chat_dm_permissions.reload.pluck(:target_identity)

    version = principal.reload.sync_config_cache_version
    direct.destroy!
    assert_equal version + 1, principal.reload.sync_config_cache_version
  end
end
