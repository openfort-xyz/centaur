require "test_helper"

class UserTest < ActiveSupport::TestCase
  def valid_attrs(overrides = {})
    { email: "new-user@example.com", password: "password123456" }.merge(overrides)
  end

  test "is valid with email and password" do
    assert User.new(valid_attrs).valid?
  end

  test "requires email" do
    user = User.new(valid_attrs(email: nil))
    assert_not user.valid?
    assert_includes user.errors[:email], "can't be blank"
  end

  test "rejects malformed email" do
    user = User.new(valid_attrs(email: "not-an-email"))
    assert_not user.valid?
    assert_includes user.errors[:email], "is invalid"
  end

  test "email is unique" do
    existing = users(:acme_admin)
    dup = User.new(valid_attrs(email: existing.email))
    assert_not dup.valid?
    assert_includes dup.errors[:email], "has already been taken"
  end

  test "email is normalized to lowercase and stripped" do
    user = User.create!(valid_attrs(email: "  Mixed@Case.EXAMPLE  "))
    assert_equal "mixed@case.example", user.email
  end

  test "email uniqueness is case-insensitive via normalization" do
    existing = users(:acme_admin)
    dup = User.new(valid_attrs(email: existing.email.upcase))
    assert_not dup.valid?
    assert_includes dup.errors[:email], "has already been taken"
  end

  test "is valid without a password (SSO-only user)" do
    user = User.new(valid_attrs.except(:password))
    assert user.valid?
  end

  test "rejects short passwords" do
    user = User.new(valid_attrs(password: "short"))
    assert_not user.valid?
    assert_includes user.errors[:password], "is too short (minimum is 12 characters)"
  end

  test "authenticate returns user with correct password" do
    user = User.create!(valid_attrs)
    assert_equal user, user.authenticate("password123456")
  end

  test "authenticate returns false with wrong password" do
    user = User.create!(valid_attrs)
    assert_equal false, user.authenticate("wrong-password!!")
  end

  test "declares usr as its oid prefix" do
    assert_equal "usr", User.oid_prefix
  end

  test "find_by_oid round-trips" do
    user = users(:acme_admin)
    assert_equal user, User.find_by_oid(user.oid)
  end

  test "status defaults to pending" do
    assert_equal "pending", User.new.status
  end

  test "rejects an unknown status" do
    user = User.new(valid_attrs(status: "bogus"))
    assert_not user.valid?
    assert_includes user.errors[:status], "is not included in the list"
  end

  test "approve! activates and records the approver" do
    user = User.create!(valid_attrs(email: "approve-me@example.com").except(:password))
    admin = users(:acme_admin)
    user.approve!(by: admin)
    assert user.reload.active?
    assert_equal admin, user.approved_by
    assert_not_nil user.approved_at
  end

  test "destroys linked identities" do
    user = User.create!(valid_attrs(email: "with-identity@example.com").except(:password))
    user.user_identities.create!(provider: "google", subject: "destroy-sub")
    assert_difference -> { UserIdentity.count }, -1 do
      user.destroy
    end
  end

  # --- link_or_provision -----------------------------------------------------

  def identity(overrides = {})
    { subject: "sub-1", email: "newcomer@example.com", email_verified: true, name: "New Comer" }.merge(overrides)
  end

  test "link_or_provision creates an active user + identity for an unknown email" do
    user = nil
    assert_difference -> { User.count }, 1 do
      assert_difference -> { UserIdentity.count }, 1 do
        user = User.link_or_provision(provider: "google", identity: identity)
      end
    end
    assert user.active?
    assert_not user.admin?
    assert_equal "New Comer", user.name
    assert_equal [ [ "google", "sub-1" ] ], user.user_identities.pluck(:provider, :subject)
  end

  test "link_or_provision supports an Okta identity" do
    user = User.link_or_provision(
      provider: "okta",
      identity: identity(subject: "okta-sub", email: "okta-user@example.com")
    )

    assert user.active?
    assert_equal [ [ "okta", "okta-sub" ] ], user.user_identities.pluck(:provider, :subject)
  end

  test "link_or_provision rejects SSO emails outside the configured domain allowlist" do
    ENV["CENTAUR_CONSOLE_SSO_EMAIL_DOMAINS"] = "acme.example example.org"
    assert_no_difference [ "User.count", "UserIdentity.count" ] do
      assert_raises(User::SsoEmailDomainNotAllowed) do
        User.link_or_provision(provider: "google",
                              identity: identity(subject: "outside-sub", email: "newcomer@example.com"))
      end
    end
  ensure
    ENV.delete("CENTAUR_CONSOLE_SSO_EMAIL_DOMAINS")
  end

  test "link_or_provision allows SSO emails inside the configured domain allowlist" do
    ENV["CENTAUR_CONSOLE_SSO_EMAIL_DOMAINS"] = "acme.example example.org"
    user = nil
    assert_difference -> { User.count }, 1 do
      user = User.link_or_provision(provider: "google",
                                    identity: identity(subject: "inside-sub", email: "worker@acme.example"))
    end
    assert user.active?
  ensure
    ENV.delete("CENTAUR_CONSOLE_SSO_EMAIL_DOMAINS")
  end

  test "link_or_provision returns the existing user for a returning identity" do
    existing = user_identities(:acme_admin_google)
    user = nil
    assert_no_difference [ "User.count", "UserIdentity.count" ] do
      user = User.link_or_provision(provider: existing.provider,
                                    identity: identity(subject: existing.subject, email: existing.email))
    end
    assert_equal existing.user, user
  end

  test "link_or_provision rejects a returning identity outside the configured domain allowlist" do
    ENV["CENTAUR_CONSOLE_SSO_EMAIL_DOMAINS"] = "globex.example"
    existing = user_identities(:acme_admin_google)
    assert_no_difference [ "User.count", "UserIdentity.count" ] do
      assert_raises(User::SsoEmailDomainNotAllowed) do
        User.link_or_provision(provider: existing.provider,
                              identity: identity(subject: existing.subject, email: existing.email))
      end
    end
  ensure
    ENV.delete("CENTAUR_CONSOLE_SSO_EMAIL_DOMAINS")
  end

  test "link_or_provision links a new identity to an existing user by verified email" do
    target = users(:globex_admin)
    user = nil
    assert_no_difference -> { User.count } do
      assert_difference -> { target.user_identities.count }, 1 do
        user = User.link_or_provision(provider: "slack",
                                      identity: identity(subject: "slack-new", email: target.email))
      end
    end
    assert_equal target, user
  end

  test "link_or_provision preserves the Slack workspace id" do
    user = User.link_or_provision(
      provider: "slack",
      identity: identity(subject: "slack-user", email: "slack-user@example.com", team_id: " T123 ")
    )

    slack_identity = user.user_identities.find_by!(provider: "slack")
    assert_equal "T123", slack_identity.team_id
  end

  test "link_or_provision will not let an unverified email adopt an existing account" do
    target = users(:globex_admin)
    assert_raises(ActiveRecord::RecordInvalid) do
      User.link_or_provision(provider: "slack",
                             identity: identity(subject: "spoof", email: target.email, email_verified: false))
    end
  end

  # --- a renamed Google account ------------------------------------------------

  # Google reports acme_admin's account under a new address on the next
  # sign-in: same subject, the old address kept as an alias.
  def google_reports_new_address(email = "admin@renamed.example")
    existing = user_identities(:acme_admin_google)
    User.link_or_provision(provider: existing.provider,
                           identity: identity(subject: existing.subject, email: email))
  end

  test "a returning identity with a new address never changes the stored email" do
    user = users(:acme_admin)
    slack = user.user_identities.create!(provider: "slack", subject: "U0ADMIN001",
                                         email: user.email, email_verified: true)

    assert_no_difference -> { User.count } do
      assert_equal user, google_reports_new_address
      assert_equal user, User.link_or_provision(
        provider: "slack", identity: identity(subject: slack.subject, email: "anything@elsewhere.example")
      )
    end

    assert_equal "admin@acme.example", user.reload.email
    assert_equal "admin@renamed.example", user_identities(:acme_admin_google).reload.email
    assert_equal %w[admin@renamed.example admin@acme.example], user.google_addresses
  end

  test "for_google_account finds a renamed user by account id before any sign-in" do
    user = users(:acme_admin)
    subject = user_identities(:acme_admin_google).subject

    assert_equal user, User.for_google_account(subject: subject, email: "admin@renamed.example")
    assert_nil User.for_google_account(subject: nil, email: "admin@renamed.example")

    google_reports_new_address
    assert_equal user, User.for_google_account(subject: nil, email: "admin@renamed.example")
    assert_equal user, User.for_google_account(subject: nil, email: " Admin@Acme.Example ")
  end

  test "for_google_account never gives another Google account a user by one of their addresses" do
    google_reports_new_address

    %w[admin@acme.example admin@renamed.example].each do |address|
      assert_nil User.for_google_account(subject: "another-account", email: address), address
    end
    # A user with no Google sign-in has only the email to be found by.
    assert_equal users(:member_user),
                 User.for_google_account(subject: "another-account", email: users(:member_user).email)
  end

  test "for_google_account ignores unverified sign-in emails and addresses two users share" do
    users(:member_user).user_identities.create!(provider: "google", subject: "member-sub",
                                                email: "claimed@acme.example", email_verified: false)
    assert_nil User.for_google_account(subject: nil, email: "claimed@acme.example")
    assert_nil User.for_google_account(subject: nil, email: "")

    users(:member_user).user_identities.create!(provider: "google", subject: "member-sub-2",
                                                email: users(:globex_admin).email, email_verified: true)
    assert_nil User.for_google_account(subject: nil, email: users(:globex_admin).email)
  end

  test "a first sign-in through another provider joins a renamed user under either address" do
    user = google_reports_new_address

    assert_no_difference -> { User.count } do
      assert_equal user, User.link_or_provision(
        provider: "slack", identity: identity(subject: "U0ADMIN001", email: "admin@acme.example")
      )
      assert_equal user, User.link_or_provision(
        provider: "okta", identity: identity(subject: "okta-admin", email: "admin@renamed.example")
      )
    end
  end

  test "a second Google account reporting a user's address never joins that user" do
    user = google_reports_new_address

    %w[admin@acme.example admin@renamed.example].each do |address|
      assert_no_difference -> { user.user_identities.count } do
        joined = begin
          User.link_or_provision(provider: "google", identity: identity(subject: "another-account", email: address))
        rescue ActiveRecord::RecordInvalid
          nil
        end
        assert_not_equal user, joined, address
      end
    end
  end

  test "link_or_provision makes a bootstrap-allowlisted email active and admin" do
    ENV["CENTAUR_CONSOLE_BOOTSTRAP_ADMINS"] = "boss@example.com"
    user = User.link_or_provision(provider: "google", identity: identity(subject: "boss-sub", email: "boss@example.com"))
    assert user.active?
    assert user.admin?
  ensure
    ENV.delete("CENTAUR_CONSOLE_BOOTSTRAP_ADMINS")
  end

  test "link_or_provision does not bootstrap admin from an unverified email" do
    ENV["CENTAUR_CONSOLE_BOOTSTRAP_ADMINS"] = "boss@example.com"
    user = User.link_or_provision(provider: "google",
                                  identity: identity(subject: "boss-sub", email: "boss@example.com",
                                                     email_verified: false))
    assert user.active?
    assert_not user.admin?
  ensure
    ENV.delete("CENTAUR_CONSOLE_BOOTSTRAP_ADMINS")
  end

  test "link_or_provision activates a returning legacy-pending user" do
    user = User.link_or_provision(provider: "slack",
                                  identity: identity(subject: "late-sub", email: "worker@acme.example"))
    user.update!(status: :pending)

    returning = User.link_or_provision(provider: "slack",
                                       identity: identity(subject: "late-sub", email: "worker@acme.example"))
    assert_equal user, returning
    assert returning.active?
    assert_not returning.admin?
    assert_not_nil returning.approved_at
  end

  test "link_or_provision never reactivates a disabled user" do
    user = User.link_or_provision(provider: "slack",
                                  identity: identity(subject: "gone-sub", email: "worker@acme.example"))
    user.update!(status: :disabled)

    returning = User.link_or_provision(provider: "slack",
                                       identity: identity(subject: "gone-sub", email: "worker@acme.example"))
    assert returning.disabled?
  end
end
