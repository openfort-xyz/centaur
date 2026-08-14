module ApiServer
  module Jwt
    DEFAULT_AUDIENCE = "centaur-api".freeze
    DEFAULT_ISSUER = "centaur-console".freeze
    DEFAULT_WINDOW_SECONDS = 15.minutes.to_i
    DEFAULT_TTL_SECONDS = 1.hour.to_i

    module_function

    def encode_for_principal(principal, now: Time.current)
      channels = principal.slack_channel_ids_by_permission
      google_chat_spaces = principal.google_chat_space_names_by_permission
      dm_setup_targets = principal.google_chat_dm_setup_targets
      return nil if channels.values.all?(&:empty?) && google_chat_spaces.values.all?(&:empty?) && dm_setup_targets.empty?

      claims = { "sub" => principal.oid }
      unless channels.values.all?(&:empty?)
        claims["slack"] = {
          "upload_channels" => channels.fetch(:upload).sort,
          "download_channels" => channels.fetch(:download).sort,
          "history_channels" => channels.fetch(:history).sort
        }
      end
      unless google_chat_spaces.values.all?(&:empty?) && dm_setup_targets.empty?
        claims["google_chat"] = GoogleChatSpacePermission::PERMISSION_FLAGS.to_h do |flag|
          [ flag.fetch(:claim).to_s, google_chat_spaces.fetch(flag.fetch(:claim)).sort ]
        end.merge("dm_setup_targets" => dm_setup_targets.sort)
      end

      CentaurJwt::WindowedToken.encode(
        subject_oid: principal.oid,
        audience: audience,
        issuer: issuer,
        window_seconds: DEFAULT_WINDOW_SECONDS,
        ttl_seconds: DEFAULT_TTL_SECONDS,
        now: now,
        claims: claims
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
