module ApiServer
  module Jwt
    DEFAULT_AUDIENCE = "centaur-api".freeze
    DEFAULT_ISSUER = "centaur-console".freeze
    DEFAULT_WINDOW_SECONDS = 15.minutes.to_i
    DEFAULT_TTL_SECONDS = 1.hour.to_i
    CONSOLE_SERVICE_SUBJECT = "centaur-console".freeze

    module_function

    def encode_for_principal(principal, now: Time.current)
      channels = principal.slack_channel_ids_by_permission
      google_chat_spaces = principal.google_chat_space_names_by_permission
      google_chat_claims = GoogleChatSpacePermission::PERMISSION_FLAGS.to_h do |flag|
        [ flag.fetch(:claim).to_s, google_chat_spaces.fetch(flag.fetch(:claim)).sort ]
      end.merge("dm_setup_targets" => principal.google_chat_dm_setup_targets.sort)
      reader_subjects = principal.google_chat_reader_subjects_by_space
      google_chat_claims["reader_subjects"] = reader_subjects unless reader_subjects.empty?

      CentaurJwt::WindowedToken.encode(
        subject_oid: principal.oid,
        audience: audience,
        issuer: issuer,
        window_seconds: DEFAULT_WINDOW_SECONDS,
        ttl_seconds: DEFAULT_TTL_SECONDS,
        now: now,
        claims: {
          "sub" => principal.oid,
          "capabilities" => {
            "sessions_read" => principal.sandbox_sessions_read_enabled,
            "workflows_read" => principal.sandbox_workflows_read_enabled,
            "workflows_write" => principal.sandbox_workflows_write_enabled
          },
          "slack" => {
            "upload_channels" => channels.fetch(:upload).sort,
            "download_channels" => channels.fetch(:download).sort,
            "history_channels" => channels.fetch(:history).sort
          },
          "google_chat" => google_chat_claims
        }
      )
    end

    def encode_for_console_service(now: Time.current)
      CentaurJwt::WindowedToken.encode(
        subject_oid: CONSOLE_SERVICE_SUBJECT,
        audience: audience,
        issuer: issuer,
        window_seconds: DEFAULT_WINDOW_SECONDS,
        ttl_seconds: DEFAULT_TTL_SECONDS,
        now: now,
        claims: {
          "sub" => CONSOLE_SERVICE_SUBJECT,
          "token_use" => "console_service"
        }
      )
    end

    # Kept for callers that reason about rotation boundaries directly
    # (snapshot staleness checks, tests).
    def window_start_for(principal, timestamp)
      CentaurJwt::WindowedToken.window_start(principal.oid, timestamp, window_seconds: DEFAULT_WINDOW_SECONDS)
    end

    def rotation_offset(principal)
      CentaurJwt::WindowedToken.rotation_offset(principal.oid, window_seconds: DEFAULT_WINDOW_SECONDS)
    end

    def audience
      ENV["CENTAUR_API_JWT_AUDIENCE"].presence || DEFAULT_AUDIENCE
    end

    def issuer
      ENV["CENTAUR_API_JWT_ISSUER"].presence || DEFAULT_ISSUER
    end
  end
end
