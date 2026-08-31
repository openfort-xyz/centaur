# Display names for the Google Chat spaces a console user can deliver to.
#
# Grants store bare `spaces/<id>` resource names; the bot knows the human
# names. This asks api-rs's Google Chat proxy for the author's granted spaces
# (minting their principal JWT, so the proxy's own filtering applies) and
# caches the answer briefly. Lookups are best-effort: on any failure the UI
# falls back to the raw resource names.
class GoogleChatSpaceDirectory
  CACHE_TTL = 10.minutes

  def self.display_names(user, client: nil)
    principal = ConsoleUserPrincipalProvisioner.call(user)
    Rails.cache.fetch("google_chat_space_names/#{principal.oid}", expires_in: CACHE_TTL) do
      client ||= CentaurApiClient.new(
        token_provider: -> { ApiServer::Jwt.encode_for_principal(principal) }
      )
      client.list_google_chat_spaces.fetch("spaces", []).each_with_object({}) do |space, names|
        name = space["name"].to_s
        display_name = space["displayName"].to_s
        names[name] = display_name if name.present? && display_name.present?
      end
    end
  rescue StandardError => e
    Rails.logger.warn("google_chat_space_directory_failed error=#{e.class}: #{e.message}")
    {}
  end
end
