require "test_helper"

class ConsoleUserPrincipalProvisionerTest < ActiveSupport::TestCase
  test "creates and then reuses a scoped principal for the Console user" do
    user = users(:member_user)

    assert_difference -> { Principal.count }, 1 do
      @principal = ConsoleUserPrincipalProvisioner.call(user)
    end
    same_principal = ConsoleUserPrincipalProvisioner.call(user)

    assert_equal @principal, same_principal
    assert_equal "console_user", @principal.kind
    assert_equal user, @principal.console_user
    assert_equal "centaur", @principal.labels["managed-by"]
    assert_includes @principal.roles, Role.find_by!(foreign_id: "user-mcp")
  end

  test "a user whose email changes keeps their principal, grants and roles" do
    user = users(:member_user)
    principal = ConsoleUserPrincipalProvisioner.call(user)
    grant = principal.grants.create!(static_secret: static_secrets(:github_token_inject), created_by: user)

    user.update!(email: "renamed-member@example.com")

    assert_no_difference -> { Principal.count } do
      assert_equal principal, ConsoleUserPrincipalProvisioner.call(user)
    end
    assert_equal principal.foreign_id, principal.reload.foreign_id
    assert_includes principal.grants, grant
    assert_includes principal.roles, Role.find_by!(foreign_id: "user-mcp")
  end

  test "two users never share a principal" do
    first = ConsoleUserPrincipalProvisioner.call(users(:member_user))
    second = ConsoleUserPrincipalProvisioner.call(users(:globex_admin))

    assert_not_equal first, second
    assert_equal users(:globex_admin), second.console_user
  end

  test "repeated calls leave an unchanged principal untouched" do
    user = users(:member_user)
    principal = ConsoleUserPrincipalProvisioner.call(user)

    assert_no_changes -> { principal.reload.updated_at } do
      ConsoleUserPrincipalProvisioner.call(user)
    end
  end
end
