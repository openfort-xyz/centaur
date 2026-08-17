require "test_helper"

class GoogleChatJwtTest < ActiveSupport::TestCase
  test "JWT contains stable sorted Google Chat operation and DM claims" do
    principal = principals(:acme_channel)
    principal.google_chat_space_permissions.create!(
      space_name: "spaces/BBBB", send_enabled: true, delete_enabled: true,
      download_enabled: true, members_enabled: true
    )
    roles(:acme_infra).google_chat_space_permissions.create!(
      space_name: "spaces/AAAA", update_enabled: true, upload_enabled: true,
      history_enabled: true, reactions_enabled: true
    )
    principal.google_chat_dm_permissions.create!(target_identity: "z@example.com", setup_enabled: true)
    roles(:acme_infra).google_chat_dm_permissions.create!(target_identity: "a@example.com", setup_enabled: true)

    with_env("CENTAUR_JWT_SIGNING_SECRET" => "test-secret") do
      claims = jwt_payload(ApiServer::Jwt.encode_for_principal(principal, now: Time.zone.at(1_700_000_000)))
      assert_equal({
        "send_spaces" => [ "spaces/BBBB" ],
        "update_spaces" => [ "spaces/AAAA" ],
        "delete_spaces" => [ "spaces/BBBB" ],
        "upload_spaces" => [ "spaces/AAAA" ],
        "download_spaces" => [ "spaces/BBBB" ],
        "history_spaces" => [ "spaces/AAAA" ],
        "member_spaces" => [ "spaces/BBBB" ],
        "reaction_spaces" => [ "spaces/AAAA" ],
        "dm_setup_targets" => %w[a@example.com z@example.com]
      }, claims.fetch("google_chat"))
      assert_equal 1.hour.to_i, claims.fetch("exp") - claims.fetch("iat")
      assert_equal ApiServer::Jwt.rotation_offset(principal),
                   claims.fetch("iat") % ApiServer::Jwt::DEFAULT_WINDOW_SECONDS
      refute_includes claims.to_json, "test-secret"
    end
  end

  test "JWT merges direct and role Google Chat grants and coexists with Slack" do
    principal = principals(:acme_channel)
    principal.google_chat_space_permissions.create!(space_name: "spaces/AAAA", send_enabled: true)
    roles(:acme_infra).google_chat_space_permissions.create!(space_name: "spaces/AAAA", history_enabled: true)
    principal.slack_channel_permissions.create!(channel_id: "C0123456789", upload_enabled: true)

    with_env("CENTAUR_JWT_SIGNING_SECRET" => "test-secret") do
      claims = jwt_payload(ApiServer::Jwt.encode_for_principal(principal))
      assert_equal [ "C0123456789" ], claims.dig("slack", "upload_channels")
      assert_equal [ "spaces/AAAA" ], claims.dig("google_chat", "send_spaces")
      assert_equal [ "spaces/AAAA" ], claims.dig("google_chat", "history_spaces")
    end
  end

  test "JWT maps authorized DM spaces to server-derived reader subjects" do
    principal = principals(:acme_channel)
    dm = Principal.create!(
      foreign_id: "gchat-space-dm",
      name: "Google Chat DM",
      kind: "gchat_dm",
      labels: { "gchat_space_id" => "DM", "google_email" => " Reader@Example.COM " },
      created_by: principal.created_by
    )
    principal.update!(labels: principal.labels.merge(
      "google_chat_reader_subjects" => {
        "spaces/LEGACY" => " Legacy@Example.COM ",
        "spaces/UNAUTHORIZED" => "other@example.com"
      }
    ))
    principal.google_chat_space_permissions.create!(space_name: "spaces/DM", history_enabled: true)
    principal.google_chat_space_permissions.create!(space_name: "spaces/LEGACY", history_enabled: true)
    principal.google_chat_space_permissions.create!(space_name: "spaces/CHANNEL", history_enabled: true)

    with_env("CENTAUR_JWT_SIGNING_SECRET" => "test-secret") do
      claims = jwt_payload(ApiServer::Jwt.encode_for_principal(principal))
      assert_equal({
        "spaces/DM" => "reader@example.com",
        "spaces/LEGACY" => "legacy@example.com"
      }, claims.dig("google_chat", "reader_subjects"))

      principal.update!(labels: principal.labels.merge(
        "google_chat_reader_subjects" => {
          "spaces/DM" => "other@example.com",
          "spaces/LEGACY" => "legacy@example.com"
        }
      ))
      assert_equal(
        { "spaces/LEGACY" => "legacy@example.com" },
        jwt_payload(ApiServer::Jwt.encode_for_principal(principal)).dig("google_chat", "reader_subjects")
      )

      principal.update!(labels: principal.labels.merge(
        "google_chat_reader_subjects" => { "spaces/LEGACY" => "legacy@example.com" }
      ))
      dm.update!(labels: dm.labels.merge("google_email" => "invalid"))
      assert_equal(
        { "spaces/LEGACY" => "legacy@example.com" },
        jwt_payload(ApiServer::Jwt.encode_for_principal(principal)).dig("google_chat", "reader_subjects")
      )

      principal.update!(labels: principal.labels.merge(
        "google_chat_reader_subjects" => { "spaces/LEGACY" => "invalid" }
      ))
      refute jwt_payload(ApiServer::Jwt.encode_for_principal(principal)).dig("google_chat").key?("reader_subjects")
    end
  end

  test "JWT exists for Chat-only grants, rotates every 15 minutes and is nil without either platform" do
    principal = principals(:acme_user_bob)
    principal.google_chat_dm_permissions.create!(target_identity: "person@example.com", setup_enabled: true)
    window = ApiServer::Jwt::DEFAULT_WINDOW_SECONDS
    boundary = 1_700_000_100 + ApiServer::Jwt.rotation_offset(principal)

    with_env("CENTAUR_JWT_SIGNING_SECRET" => "test-secret") do
      first = ApiServer::Jwt.encode_for_principal(principal, now: Time.zone.at(boundary + 1))
      second = ApiServer::Jwt.encode_for_principal(principal, now: Time.zone.at(boundary + window - 1))
      third = ApiServer::Jwt.encode_for_principal(principal, now: Time.zone.at(boundary + window))
      assert_equal first, second
      refute_equal first, third
      assert_nil jwt_payload(first)["slack"]

      principal.google_chat_dm_permissions.destroy_all
      principal.reset_google_chat_permissions_cache!
      assert_nil ApiServer::Jwt.encode_for_principal(principal)
    end
  end

  test "proxy sync snapshot carries effective Google Chat claims" do
    principal = principals(:acme_channel)
    principal.google_chat_space_permissions.create!(space_name: "spaces/AAAA", send_enabled: true)
    roles(:acme_infra).google_chat_dm_permissions.create!(
      target_identity: "person@example.com", setup_enabled: true
    )

    with_env(
      "CENTAUR_JWT_SIGNING_SECRET" => "test-secret",
      "CENTAUR_API_URL" => "http://api.internal:8080"
    ) do
      config = PrincipalSyncConfigSnapshot.config_for(principal)
      token = config.fetch("secrets").find do |secret|
        secret.dig("inject", "header") == "Authorization" && secret.dig("source", "type") == "control_plane"
      end.dig("source", "value")
      claims = jwt_payload(token)
      assert_equal [ "spaces/AAAA" ], claims.dig("google_chat", "send_spaces")
      assert_equal [ "person@example.com" ], claims.dig("google_chat", "dm_setup_targets")
    end
  end

  private

  def jwt_payload(token)
    JSON.parse(Base64.urlsafe_decode64(token.split(".").fetch(1)))
  end
end
